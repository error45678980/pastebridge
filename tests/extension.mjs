/* 真实扩展环境集成测试
 *
 * 与 e2e.mjs 的区别：这里真的把扩展装进浏览器，走 chrome.scripting 注入，
 * 并且分别验证 MAIN 世界与 ISOLATED 世界（降级模式）两条通道。
 *
 *   node tests/extension.mjs
 *
 * 为了在没有 activeTab 授权的情况下也能注入，测试会把扩展复制一份到临时目录，
 * 并额外声明 http://127.0.0.1/* 的 host_permissions —— 正式 manifest 不含这条。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'demo');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  const f = path.join(DEMO, p === '/' ? 'index.html' : p);
  if (!f.startsWith(DEMO)) return res.writeHead(403).end();
  fs.readFile(f, (e, b) => {
    if (e) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = 'http://127.0.0.1:' + PORT;

/* ---------------- 准备测试版扩展 ---------------- */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-'));
const extDir = path.join(tmpRoot, 'ext');
fs.mkdirSync(extDir, { recursive: true });

for (const item of ['manifest.json', 'popup', 'page', 'icons']) {
  fs.cpSync(path.join(ROOT, item), path.join(extDir, item), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* ---------------- 启动浏览器 ---------------- */

const userDataDir = path.join(tmpRoot, 'profile');
const launchArgs = [
  `--disable-extensions-except=${extDir}`,
  `--load-extension=${extDir}`
];

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

/* ---------------- 打开演示页与弹窗页 ---------------- */

const demo = await context.newPage();
await demo.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
await demo.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 120000 });

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForTimeout(300);

const consoleErrors = [];
popup.on('pageerror', (e) => consoleErrors.push(e.message));
popup.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

/* ---------------- 取演示页 tabId ---------------- */

const tabId = await popup.evaluate(async (origin) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || '').startsWith(origin));
  return hit ? hit.id : null;
}, ORIGIN);

if (tabId == null) {
  console.error('FAIL 扩展看不到演示页标签（host_permissions 未生效？）');
  await context.close();
  server.close();
  process.exit(1);
}

/* ---------------- 通道测试 ---------------- */

const FILES = ['page/core.js', 'page/detect.js', 'page/insert.js', 'page/picker.js', 'page/main.js'];
const KINDS = ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'];
const MARK = 'INJECTED_VIA_EXTENSION';

const results = [];

async function testWorld(world) {
  const injected = await popup.evaluate(
    async ({ tabId, files, world }) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files, world });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    },
    { tabId, files: FILES, world }
  );

  if (!injected.ok) {
    results.push({ world, kind: '-', ok: false, note: '注入失败: ' + injected.err });
    return;
  }

  const pre = await popup.evaluate(
    async ({ tabId, world }) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        func: (p) => (window.__WB__ ? window.__WB__.run(p) : { ok: false, reason: 'no-facade' }),
        args: [{ op: 'precheck' }]
      });
      return r.result;
    },
    { tabId, world }
  );

  results.push({
    world,
    kind: 'precheck',
    ok: !!(pre && pre.count === KINDS.length),
    note: `识别 ${pre && pre.count}/${KINDS.length} 个`
  });

  for (const kind of KINDS) {
    const choice = pre && pre.choices ? pre.choices.find((c) => c.kind === kind) : null;
    if (!choice) {
      results.push({ world, kind, ok: false, note: '未识别' });
      continue;
    }

    await demo.evaluate((k) => window.__demo.setValue(k, ''), kind);

    const r = await popup.evaluate(
      async ({ tabId, world, code, i }) => {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world,
          func: (p) => window.__WB__.run(p),
          args: [{ op: 'insert', code, choice: i }]
        });
        return res.result;
      },
      { tabId, world, code: MARK + '_' + kind, i: choice.i }
    );

    const value = await demo.evaluate((k) => window.__demo.getValue(k), kind);
    const ok = !!(r && r.ok) && String(value || '').indexOf(MARK + '_' + kind) >= 0;
    results.push({
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

/* ---------------- 弹窗 UI 与完整链路 ---------------- */

const ui = {};

await demo.click('#ta');
await popup.evaluate(
  async ({ tabId, origin }) => {
    S.tabId = tabId;
    S.url = origin + '/index.html';
    S.origin = origin;
    await precheck();
  },
  { tabId, origin: ORIGIN }
);

ui.chipAfterPrecheck = (await popup.textContent('#chip')).trim();
ui.insertDisabled = await popup.isDisabled('#insert');

await popup.fill('#code', 'const fromPopup = "hello world";');
await popup.click('#insert');
await popup.waitForTimeout(2000);

ui.chipAfterInsert = (await popup.textContent('#chip')).trim();
const taValue = await demo.evaluate(() => document.getElementById('ta').value);
ui.inserted = taValue.indexOf('const fromPopup = "hello world";') >= 0;
ui.history = await popup.evaluate(async () => {
  const { history = [] } = await chrome.storage.local.get('history');
  return history.length;
});
ui.draft = await popup.evaluate(async () => {
  const { draft } = await chrome.storage.local.get('draft');
  return draft && draft.code ? draft.code.length : 0;
});

await popup.screenshot({ path: path.join(ROOT, 'tests', 'popup.png') });

/* ---------------- 报告 ---------------- */

await context.close();
server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n注入通道：');
console.log('─'.repeat(74));
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${String(r.world).padEnd(9)} ${String(r.kind).padEnd(9)} ` +
      `${String(r.method || '-').padEnd(12)} ${r.verified || '-'}${r.note ? '  ← ' + r.note : ''}`
  );
}

console.log('\n弹窗链路：');
console.log('─'.repeat(74));
const checks = [
  ['预检状态', /就绪|已聚焦|编辑器/.test(ui.chipAfterPrecheck), ui.chipAfterPrecheck],
  ['插入按钮可用', ui.insertDisabled === false, 'disabled=' + ui.insertDisabled],
  ['内容进入 textarea', ui.inserted, ui.chipAfterInsert],
  ['历史已记录', ui.history >= 1, 'history=' + ui.history],
  ['草稿已保存', ui.draft > 0, 'draft=' + ui.draft + ' 字符']
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
