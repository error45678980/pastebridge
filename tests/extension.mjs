/* 真实扩展环境集成测试
 *
 * 与 e2e.mjs 的区别：这里真的把扩展装进浏览器，走 chrome.scripting 注入，
 * 并且分别验证 MAIN 世界与 ISOLATED 世界（降级模式）两条通道。
 *
 *   node tests/extension.mjs
 *
 * 覆盖两块场地：
 *   · demo/index.html  代码编辑器（依赖 CDN，加载失败会跳过而不判失败）
 *   · demo/rich.html   富文本 / 聊天框（纯离线夹具，确定性覆盖）
 *
 * 为了在没有 activeTab 授权的情况下也能注入，测试会把扩展复制一份到临时目录，
 * 并额外声明 http://127.0.0.1/* 的 host_permissions —— 正式 manifest 不含这条。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PB_FILES = require('../lib/files.js');

const DEMO = path.join(ROOT, 'demo');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

function makeServer() {
  return http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const f = path.join(DEMO, p === '/' ? 'index.html' : p);
    if (!f.startsWith(DEMO)) return res.writeHead(403).end();
    fs.readFile(f, (e, b) => {
      if (e) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(b);
    });
  });
}

const server = makeServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = 'http://127.0.0.1:' + PORT;

/* 第二个端口：用来造真正的跨域子帧（同 host 不同 port = 不同源） */
const server2 = makeServer();
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const ORIGIN2 = 'http://127.0.0.1:' + server2.address().port;

/* ---------------- 准备测试版扩展 ---------------- */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-'));
const extDir = path.join(tmpRoot, 'ext');
fs.mkdirSync(extDir, { recursive: true });

for (const item of ['manifest.json', 'popup', 'page', 'icons', 'background', 'lib', 'workbench']) {
  fs.cpSync(path.join(ROOT, item), path.join(extDir, item), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
/* debugger 在正式包里是可选权限；测试里直接授予，才能验证 CDP 链路 */
manifest.permissions = (manifest.permissions || []).concat(['debugger']);
manifest.optional_permissions = (manifest.optional_permissions || []).filter((p) => p !== 'debugger');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* ---------------- 启动浏览器 ---------------- */

const userDataDir = path.join(tmpRoot, 'profile');
const launchArgs = [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`];

let context;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: launchArgs,
    viewport: { width: 1400, height: 950 }
  });
} catch (e) {
  console.log('  headless 模式加载扩展失败，改用有头模式：' + e.message);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: launchArgs,
    viewport: { width: 1400, height: 950 }
  });
}

/* ---------------- 找扩展 ID ---------------- */

async function readExtensionId() {
  const p = await context.newPage();
  try {
    await p.goto('chrome://extensions');
    await p.waitForTimeout(1200);
    return await p.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list || !list.shadowRoot) return null;
      const items = [...list.shadowRoot.querySelectorAll('extensions-item')];
      for (const it of items) {
        const id = it.id || it.getAttribute('data-extension-id') || it.getAttribute('id');
        if (id) return id;
      }
      return null;
    });
  } finally {
    await p.close();
  }
}

const extId = await readExtensionId();
if (!extId) {
  console.error('FAIL 未能读取扩展 ID（扩展可能没有被浏览器加载，检查 manifest 是否有效）');
  await context.close();
  server.close();
  process.exit(1);
}
console.log('→ 扩展已加载，ID =', extId);

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForTimeout(300);

const consoleErrors = [];
popup.on('pageerror', (e) => consoleErrors.push(e.message));
popup.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

const results = [];
const push = (r) => results.push(r);

/* ---------------- 场地一：代码编辑器（依赖 CDN） ---------------- */

const demo = await context.newPage();
let demoReady = true;
try {
  await demo.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await demo.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 90000 });
} catch (_) {
  demoReady = false;
}

const CODE_KINDS = ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'];
const MARK = 'INJECTED_VIA_EXTENSION';

async function tabIdOf(origin) {
  return popup.evaluate(async (o) => {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || '').startsWith(o));
    return hit ? hit.id : null;
  }, origin);
}

async function injectFiles(tabId, world) {
  return popup.evaluate(
    async ({ tabId, files, world }) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files, world });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    },
    { tabId, files: PB_FILES.page, world }
  );
}

async function runOp(tabId, world, payload) {
  return popup.evaluate(
    async ({ tabId, world, payload }) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        func: (p) => (window.__WB__ ? window.__WB__.run(p) : { ok: false, reason: 'no-facade' }),
        args: [payload]
      });
      return r.result;
    },
    { tabId, world, payload }
  );
}

async function testWorld(world) {
  if (!demoReady) {
    push({ world, kind: '-', ok: true, note: '演示页 CDN 未就绪，跳过（不计失败）' });
    return;
  }
  const tabId = await tabIdOf(ORIGIN);
  if (tabId == null) {
    push({ world, kind: '-', ok: false, note: '扩展看不到演示页标签' });
    return;
  }

  const injected = await injectFiles(tabId, world);
  if (!injected.ok) {
    push({ world, kind: '-', ok: false, note: '注入失败: ' + injected.err });
    return;
  }

  const pre = await runOp(tabId, world, { op: 'precheck' });
  push({
    world,
    kind: 'precheck',
    ok: !!(pre && pre.count === CODE_KINDS.length),
    note: `识别 ${pre && pre.count}/${CODE_KINDS.length} 个`
  });

  for (const kind of CODE_KINDS) {
    const choice = pre && pre.choices ? pre.choices.find((c) => c.kind === kind) : null;
    if (!choice) {
      push({ world, kind, ok: false, note: '未识别' });
      continue;
    }
    await demo.evaluate((k) => window.__demo.setValue(k, ''), kind);
    const code = MARK + '_' + kind;
    const r = await runOp(tabId, world, { op: 'insert', code, choice: { kind, nth: choice.nth } });
    const value = await demo.evaluate((k) => window.__demo.getValue(k), kind);
    const ok = !!(r && r.ok) && String(value || '').indexOf(code) >= 0;
    push({
      world,
      kind,
      ok,
      method: r && r.method,
      verified: r && r.verified,
      note: ok ? '' : (r && r.reason) || '内容不匹配'
    });
  }
}

await testWorld('MAIN');
await testWorld('ISOLATED');

/* ---------------- 场地二：富文本 / 聊天框（纯离线） ---------------- */

const RICH_KINDS = ['pm', 'lexical', 'slate', 'draft', 'quill', 'ck5', 'tinymce', 'ce', 'textarea', 'input'];

const rich = await context.newPage();
await rich.goto(ORIGIN + '/rich.html', { waitUntil: 'domcontentloaded' });
await rich.waitForFunction(() => window.__rich && window.__rich.ready, null, { timeout: 15000 });

async function testRichWorld(world) {
  const tabId = await tabIdOf(ORIGIN + '/rich.html');
  if (tabId == null) {
    push({ world, kind: '-', ok: false, note: '扩展看不到富文本页标签' });
    return;
  }
  const injected = await injectFiles(tabId, world);
  if (!injected.ok) {
    push({ world, kind: '-', ok: false, note: '注入失败: ' + injected.err });
    return;
  }

  // 单行输入框只在聚焦时才参与候选（防站点搜索框刷屏）
  await rich.focus('#single');
  const pre = await runOp(tabId, world, { op: 'precheck' });
  push({
    world,
    kind: 'rich-precheck',
    ok: !!(pre && pre.count === RICH_KINDS.length),
    note: `识别 ${pre && pre.count}/${RICH_KINDS.length} 个`
  });

  for (const kind of RICH_KINDS) {
    const choice = pre && pre.choices ? pre.choices.find((c) => c.kind === kind) : null;
    if (!choice) {
      push({ world, kind, ok: false, note: '未识别' });
      continue;
    }
    await rich.evaluate((k) => window.__rich.setValue(k, ''), kind);
    const code = kind === 'input' ? 'FLAT_' + kind : '第一行 ' + kind + '\n第二行\n第三行';
    const r = await runOp(tabId, world, { op: 'insert', code, choice: { kind, nth: choice.nth } });
    const value = await rich.evaluate((k) => window.__rich.getValue(k), kind);
    const want = kind === 'input' ? 'FLAT_' + kind : '第二行';
    const ok = !!(r && r.ok) && String(value || '').indexOf(want) >= 0;
    push({
      world,
      kind,
      ok,
      method: r && r.method,
      verified: r && r.verified,
      note: ok ? '' : (r && r.reason) || '内容不匹配'
    });
  }
}

await testRichWorld('MAIN');
await testRichWorld('ISOLATED');

/* ---------------- 聊天框：绝不误触「回车发送」 ---------------- */

const chat = await context.newPage();
await chat.goto(ORIGIN + '/chat.html', { waitUntil: 'domcontentloaded' });
await chat.waitForFunction(() => window.__chat && window.__chat.ready, null, { timeout: 15000 });

const chatCheck = { world: 'MAIN', kind: 'chat', ok: false, note: '' };
try {
  const tabId = await tabIdOf(ORIGIN + '/chat.html');
  const injected = await injectFiles(tabId, 'MAIN');
  if (!injected.ok) throw new Error('注入失败: ' + injected.err);

  const pre = await runOp(tabId, 'MAIN', { op: 'precheck' });
  const code = 'function hello() {\n  return 1;\n}\nconst tail = 2;';
  const r = await runOp(tabId, 'MAIN', { op: 'insert', code, choice: 0 });
  const sent = await chat.evaluate(() => window.__chat.sent.pm + window.__chat.sent.textarea);
  const msgs = await chat.evaluate(() => window.__chat.messageCount('pm'));
  const value = await chat.evaluate(() => window.__chat.getValue('pm'));
  chatCheck.ok = !!(r && r.ok) && sent === 0 && msgs === 0 && String(value).indexOf('const tail = 2;') >= 0;
  chatCheck.note =
    '发送 ' + sent + ' 条 · 消息 ' + msgs + ' 条 · ' + (r && r.method) + ' · ' + (pre && pre.count) + ' 候选';
} catch (e) {
  chatCheck.note = e.message;
}
push(chatCheck);

/* ---------------- 场地三：iframe 内的编辑器 ---------------- */

const frameCheck = { world: 'MAIN', kind: 'iframe', ok: false, note: '' };
try {
  const framesPage = await context.newPage();
  await framesPage.goto(ORIGIN + '/frames.html', { waitUntil: 'domcontentloaded' });
  await framesPage.waitForFunction(() => window.__frames && window.__frames.ready, null, {
    timeout: 15000
  });
  await framesPage.evaluate((u) => window.__frames.setCross(u), ORIGIN2 + '/child.html');
  await framesPage.waitForTimeout(1500);

  const tabId = await tabIdOf(ORIGIN + '/frames.html');
  if (tabId == null) throw new Error('扩展看不到 frames 标签');

  const scan = await popup.evaluate(
    async (t) =>
      chrome.runtime.sendMessage({ type: 'pb:run', tabId: t, payload: { op: 'scan' } }),
    tabId
  );

  const frameCount = scan && scan.frames ? scan.frames.length : 0;

  /* 精确定位跨域那一帧：同 host 不同端口也是不同源，
   * 用 frames[].href 里的端口来判断，而不是「第一个非顶层帧」。 */
  const crossFrame =
    scan && scan.frames ? scan.frames.find((f) => (f.href || '').startsWith(ORIGIN2)) : null;
  const cross =
    crossFrame && scan.choices ? scan.choices.find((c) => c.frameId === crossFrame.frameId) : null;

  let inserted = false;
  let method = '-';
  if (cross) {
    const code = 'CROSS_FRAME_OK';
    const r = await popup.evaluate(
      async ({ t, code, frameId }) =>
        chrome.runtime.sendMessage({
          type: 'pb:run',
          tabId: t,
          frameIds: [frameId],
          payload: { op: 'insert', code, choice: { kind: 'textarea', nth: 1 } }
        }),
      { t: tabId, code, frameId: cross.frameId }
    );
    method = (r && r.method) || '-';

    const kids = framesPage.frames().filter((f) => f.url().startsWith(ORIGIN2));
    if (kids.length) {
      const val = await kids[0].evaluate(() => window.__child.getValue());
      inserted = String(val).indexOf(code) >= 0;
    }
  }

  frameCheck.ok = frameCount >= 2 && inserted;
  frameCheck.note =
    `帧 ${frameCount} 个 · 候选 ${scan ? scan.count : 0} 个 · 跨域帧 ${cross ? cross.frameId : '-'} · ` +
    `方法 ${method} · 跨域读回 ${inserted ? '成功' : '失败'}` +
    (frameCheck.ok ? '' : ' · scan=' + JSON.stringify(scan).slice(0, 220));
} catch (e) {
  frameCheck.note = e.message;
}
push(frameCheck);

/* ---------------- 场地四：工作台 ---------------- */

const wb = { cards: 0, hasClip: false, snips: 0, settings: 0, errors: [] };
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => wb.errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/workbench/index.html`);
  await page.waitForTimeout(700);

  await page.evaluate(async () => {
    await PBStore.putClip({ text: 'WORKBENCH_TEST_CLIP', src: { host: 'test.local' } });
    await PBStore.putSnippet({ name: '测试片段', text: 'snippet body', lang: 'js' });
    await refresh();
  });
  await page.waitForTimeout(400);

  wb.cards = await page.evaluate(() => document.querySelectorAll('#list .card').length);
  wb.hasClip = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#list .card')).some((c) =>
      c.textContent.includes('WORKBENCH_TEST_CLIP')
    )
  );

  await page.evaluate(() => document.querySelector('.nav[data-view="snippets"]').click());
  await page.waitForTimeout(400);
  wb.snips = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('#list .card')).filter((c) =>
        c.textContent.includes('测试片段')
      ).length
  );

  await page.evaluate(() => document.querySelector('.nav[data-view="settings"]').click());
  await page.waitForTimeout(400);
  wb.settings = await page.evaluate(() => document.querySelectorAll('#settingsView .set-card').length);

  await page.close();
} catch (e) {
  wb.errors.push(e.message);
}

/* ---------------- 键盘模拟（CDP） ----------------
 * Playwright 自己通过 CDP 控制页面，扩展的 chrome.debugger 很可能附不上去。
 * 附不上是预期内的环境限制，标 SKIP 而不是 FAIL。
 */

const typeCheck = { world: 'MAIN', kind: 'cdp-type', ok: false, note: '' };
try {
  const tabId = await tabIdOf(ORIGIN + '/rich.html');
  await rich.evaluate(() => window.__rich.setValue('pm', ''));
  await rich.focus('#pm');

  const r = await popup.evaluate(
    async ({ t }) =>
      chrome.runtime.sendMessage({
        type: 'pb:run',
        tabId: t,
        payload: { op: 'type', code: 'TYPED_BY_CDP', choice: { kind: 'pm', nth: 1 } }
      }),
    { t: tabId }
  );

  const val = await rich.evaluate(() => window.__rich.getValue('pm'));

  if (r && r.ok) {
    typeCheck.ok = String(val).indexOf('TYPED_BY_CDP') >= 0;
    typeCheck.note = `方法 ${r.method} · 读回 ${typeCheck.ok ? '成功' : '失败'}`;
  } else if (r && /debugger-busy|debugger-denied/.test(String(r.reason))) {
    typeCheck.ok = true;
    typeCheck.note = 'SKIP：CDP 被 Playwright 占用（' + r.reason + '）';
  } else {
    typeCheck.note = JSON.stringify(r).slice(0, 160);
  }
} catch (e) {
  typeCheck.note = e.message;
}
push(typeCheck);

/* 只认 keydown 的编辑器：整段 insertText 会被 beforeinput 拦掉，
 * 必须自动降级到逐字模拟——这条链正是 debugger 权限存在的理由。 */
const keysCheck = { world: 'MAIN', kind: 'cdp-keys', ok: false, note: '' };
try {
  const keysPage = await context.newPage();
  await keysPage.goto(ORIGIN + '/keys.html', { waitUntil: 'domcontentloaded' });
  await keysPage.waitForFunction(() => window.__keys && window.__keys.ready, null, { timeout: 15000 });

  const tabId = await tabIdOf(ORIGIN + '/keys.html');
  if (tabId == null) throw new Error('找不到 keys 标签');
  await keysPage.click('#kb');

  const r = await popup.evaluate(
    async ({ t }) =>
      chrome.runtime.sendMessage({
        type: 'pb:run',
        tabId: t,
        payload: { op: 'type', code: 'ab\ncd', choice: { kind: 'ce', nth: 1 } }
      }),
    { t: tabId }
  );

  const val = await keysPage.evaluate(() => window.__keys.getValue());
  const stats = await keysPage.evaluate(() => window.__keys.stats());

  keysCheck.ok = !!(r && r.ok) && val === 'ab\ncd';
  keysCheck.note = `方法 ${(r && r.method) || '-'} · 值 ${JSON.stringify(val)} · ${JSON.stringify(stats)}`;
  await keysPage.close();
} catch (e) {
  keysCheck.note = e.message;
}
push(keysCheck);

/* ---------------- 弹窗完整链路（离线场地） ---------------- */

const ui = {};

const richTabId = await tabIdOf(ORIGIN + '/rich.html');
await rich.click('#pm');
await popup.evaluate(
  async ({ tabId, origin }) => {
    S.tabId = tabId;
    S.url = origin + '/rich.html';
    S.origin = origin;
    await precheck();
  },
  { tabId: richTabId, origin: ORIGIN }
);

ui.chipAfterPrecheck = (await popup.textContent('#chip')).trim();
ui.insertDisabled = await popup.isDisabled('#insert');

await popup.fill('#code', 'const fromPopup = "hello world";');
await popup.click('#insert');
await popup.waitForTimeout(2500);

ui.chipAfterInsert = (await popup.textContent('#chip')).trim();
const pmValue = await rich.evaluate(() => window.__rich.getValue('pm'));
ui.inserted = pmValue.indexOf('const fromPopup = "hello world";') >= 0;
ui.history = await popup.evaluate(async () => {
  const { inserts = [] } = await chrome.storage.local.get('inserts');
  return inserts.length;
});
ui.draft = await popup.evaluate(async () => {
  const { draft } = await chrome.storage.local.get('draft');
  return draft && draft.code ? draft.code.length : 0;
});

await popup.screenshot({ path: path.join(ROOT, 'tests', 'popup.png') });

/* ---------------- 报告 ---------------- */

await context.close();
server.close();
server2.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n注入通道：');
console.log('─'.repeat(78));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${String(r.world).padEnd(9)} ${String(r.kind).padEnd(14)} ` +
      `${String(r.method || '-').padEnd(18)} ${r.verified || '-'}${r.note ? '  ← ' + r.note : ''}`
  );
}

console.log('\n弹窗链路：');
console.log('─'.repeat(78));
const checks = [
  ['预检状态', /就绪|已聚焦|编辑器/.test(ui.chipAfterPrecheck), ui.chipAfterPrecheck],
  ['插入按钮可用', ui.insertDisabled === false, 'disabled=' + ui.insertDisabled],
  ['内容进入聊天框', ui.inserted, ui.chipAfterInsert],
  ['历史已记录', ui.history >= 1, 'history=' + ui.history],
  ['草稿已保存', ui.draft > 0, 'draft=' + ui.draft + ' 字符'],
  ['工作台：历史卡片', wb.cards >= 1 && wb.hasClip, '卡片=' + wb.cards + ' 命中=' + wb.hasClip],
  ['工作台：片段视图', wb.snips >= 1, '命中=' + wb.snips],
  ['工作台：设置视图', wb.settings >= 3, '分区=' + wb.settings],
  ['工作台：无脚本错误', wb.errors.length === 0, wb.errors.slice(0, 2).join(' | ') || '无']
];
for (const [name, ok, note] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${note}`);
}

if (consoleErrors.length) {
  const uniq = [...new Set(consoleErrors.map((e) => e.replace(/\s+/g, ' ').slice(0, 150)))];
  console.log('\n弹窗控制台错误（去重）：');
  for (const e of uniq.slice(0, 5)) console.log('  ' + e);
}

const total = results.length + checks.length;
console.log('\n' + `${total - failed}/${total} 通过` + (failed ? '' : ' ✓'));
process.exit(failed ? 1 : 0);
