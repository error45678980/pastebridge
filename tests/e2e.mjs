/* 端到端验证：把 page/*.js 直接注入演示页（等价 MAIN 世界），
 * 绕开扩展 UI 与 popup 生命周期，只测最容易翻车的部分——插入本身。
 *
 *   node tests/e2e.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
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

/* ---------------- 静态服务器 ---------------- */

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(DEMO, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(DEMO)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* ---------------- 用例 ---------------- */

const KINDS = ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'];

const CASES = [
  { name: '单行', code: 'const answer = 42;' },
  {
    name: '多行 50 行',
    code: Array.from({ length: 50 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n')
  },
  { name: 'Tab 缩进', code: 'function a() {\n\tif (true) {\n\t\treturn 1;\n\t}\n}' },
  {
    name: '超长 100k',
    code: Array.from({ length: 2200 }, (_, i) => `// line ${i} ${'x'.repeat(30)}`).join('\n')
  }
];

const norm = (s) =>
  String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');

/* ---------------- 主流程 ---------------- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(90000);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text());
});

console.log('→ 加载演示页 http://127.0.0.1:' + PORT);
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 120000 });

const status = await page.evaluate(() => window.__demo.status);
console.log('  编辑器加载状态:', JSON.stringify(status));

for (const f of PB_FILES.page) {
  await page.addScriptTag({ path: path.join(ROOT, f) });
}

const pre = await page.evaluate(() => window.__WB__.run({ op: 'precheck' }));
console.log(
  '  识别到 %d 个候选: %s',
  pre.count,
  pre.choices.map((c) => `${c.i}:${c.kind}#${c.nth}(${Math.round(c.score)})`).join(' ')
);

/* 用 {kind, nth} 定位目标，而不是数组下标——
 * 候选列表会随焦点变化重新过滤，下标会漂移。 */
const indexOf = (kind) => {
  const c = pre.choices.find((x) => x.kind === kind);
  return c ? { kind: c.kind, nth: c.nth } : null;
};

const results = [];

for (const kind of KINDS) {
  const idx = indexOf(kind);
  if (idx == null) {
    results.push({ kind, case: '-', ok: false, note: '未识别到该编辑器' });
    continue;
  }
  for (const c of CASES) {
    await page.evaluate((k) => window.__demo.setValue(k, ''), kind);
    const r = await page.evaluate(
      ({ code, i }) => window.__WB__.run({ op: 'insert', code, choice: i }),
      { code: c.code, i: idx }
    );
    const doc = await page.evaluate((k) => window.__demo.getValue(k), kind);
    const ok = r && r.ok && norm(doc).includes(norm(c.code));
    results.push({
      kind,
      case: c.name,
      ok,
      method: r && r.method,
      verified: r && r.verified,
      note: ok ? '' : (r && r.reason) || '内容不匹配'
    });
  }
}

/* ---------------- 原生 API 不可用时的退路 ----------------
 * 真实站点上 Monaco 基本没有全局对象、隔离世界里读不到任何 expando，
 * 所以「拿不到实例」才是常态，必须单独验证。
 */

const FALLBACK_CODE = 'const fallbackA = 1;\nconst fallbackB = 2;';

async function fallbackCase(kind, hideExpr, restoreExpr) {
  const idx = indexOf(kind);
  if (idx == null) return { kind, case: '无原生 API', ok: false, note: '未识别到该编辑器' };
  try {
    await page.evaluate((expr) => {
      // eslint-disable-next-line no-eval
      eval(expr);
    }, hideExpr);
    await page.evaluate((k) => window.__demo.setValue(k, ''), kind);
    const r = await page.evaluate(
      ({ code, i }) => window.__WB__.run({ op: 'insert', code, choice: i }),
      { code: FALLBACK_CODE, i: idx }
    );
    const doc = await page.evaluate((k) => window.__demo.getValue(k), kind);
    const ok = !!(r && r.ok) && norm(doc).includes(norm(FALLBACK_CODE));
    return { kind, case: '无原生 API', ok, method: r && r.method, verified: r && r.verified, note: ok ? '' : (r && r.reason) || '内容不匹配' };
  } catch (e) {
    return { kind, case: '无原生 API', ok: false, note: e.message };
  } finally {
    try {
      await page.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        eval(expr);
      }, restoreExpr);
    } catch (_) {}
  }
}

results.push(
  await fallbackCase(
    'monaco',
    'window.__demo.hideMonacoApi(true)',
    'window.__demo.hideMonacoApi(false)'
  )
);
results.push(
  await fallbackCase(
    'ace',
    'const el=document.querySelector(".ace_editor"); window.__aceEnv=el.env; el.env={editor:undefined};',
    'const el=document.querySelector(".ace_editor"); if(window.__aceEnv) el.env=window.__aceEnv;'
  )
);
results.push(
  await fallbackCase(
    'cm5',
    'const el=document.querySelector(".CodeMirror"); window.__cm5Api=el.CodeMirror; el.CodeMirror=undefined;',
    'const el=document.querySelector(".CodeMirror"); if(window.__cm5Api) el.CodeMirror=window.__cm5Api;'
  )
);

/* ---------------- 多编辑器点选 ---------------- */

let pickerResult = { name: '多候选点选', ok: false, note: '' };
try {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.__WB__.state.lastFocus = null;
    ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'].forEach((k) => window.__demo.setValue(k, ''));
  });
  const r = await page.evaluate(() =>
    window.__WB__.run({ op: 'insert', code: 'PICK_ME_FROM_OVERLAY' })
  );
  if (!r || !r.pending) {
    pickerResult.note = '未进入点选模式: ' + JSON.stringify(r);
  } else {
    await page.waitForSelector('[data-wb-badge="1"]', { timeout: 5000 });
    await page.click('[data-wb-badge="1"]');
    await page.waitForTimeout(500);
    const found = await page.evaluate(() => {
      const kinds = ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'];
      for (const k of kinds) {
        const v = window.__demo.getValue(k);
        if (v && v.indexOf('PICK_ME_FROM_OVERLAY') >= 0) return k;
      }
      return null;
    });
    const after = await page.evaluate(() => window.__WB__.run({ op: 'precheck' }));
    pickerResult.ok = !!found;
    pickerResult.note = found
      ? `点选后进入 ${found}，记忆=${JSON.stringify(after.picked)}`
      : '内容未进入任何编辑器';
  }
} catch (e) {
  pickerResult.note = e.message;
}
results.push({ kind: 'picker', case: '多候选点选', ok: pickerResult.ok, note: pickerResult.note });

/* ---------------- 富文本 / 聊天框场地 ---------------- */

const RICH_KINDS = ['pm', 'lexical', 'slate', 'draft', 'quill', 'ck5', 'tinymce', 'ce', 'textarea', 'input'];

const richPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
richPage.setDefaultTimeout(90000);
richPage.on('pageerror', (e) => pageErrors.push('rich pageerror: ' + e.message));
richPage.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('rich console: ' + m.text());
});

await richPage.goto(`http://127.0.0.1:${PORT}/rich.html`, { waitUntil: 'domcontentloaded' });
await richPage.waitForFunction(() => window.__rich && window.__rich.ready, null, { timeout: 15000 });
for (const f of PB_FILES.page) {
  await richPage.addScriptTag({ path: path.join(ROOT, f) });
}

// 单行输入框只在聚焦时才参与候选（防站点搜索框刷屏），所以先点它一下
await richPage.focus('#single');
const preRich = await richPage.evaluate(() => window.__WB__.run({ op: 'precheck' }));
console.log(
  '  富文本识别到 %d 个候选: %s',
  preRich.count,
  preRich.choices.map((c) => `${c.i}:${c.kind}#${c.nth}(${Math.round(c.score)})`).join(' ')
);

const richIndexOf = (kind) => {
  const c = preRich.choices.find((x) => x.kind === kind);
  return c ? { kind: c.kind, nth: c.nth } : null;
};

const RICH_CASES = [
  { name: '单行', code: 'const answer = 42;' },
  { name: '多行 3 行', code: '第一行\n第二行\n第三行' },
  { name: '代码块 8 行', code: 'function hello() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n\nhello();\n// end' }
];

for (const kind of RICH_KINDS) {
  const idx = richIndexOf(kind);
  if (idx == null) {
    results.push({ kind, case: '-', ok: false, note: '未识别到该编辑器' });
    continue;
  }
  for (const c of RICH_CASES) {
    await richPage.evaluate((k) => window.__rich.setValue(k, ''), kind);
    const r = await richPage.evaluate(
      ({ code, i }) => window.__WB__.run({ op: 'insert', code, choice: i }),
      { code: c.code, i: idx }
    );
    const doc = await richPage.evaluate((k) => window.__rich.getValue(k), kind);

    // 单行框会把换行换成空格，这是设计行为，不算失败
    const expect = kind === 'input' ? c.code.replace(/\n/g, ' ') : c.code;
    const got = String(doc || '');
    const ok = !!(r && r.ok) && (kind === 'input' ? got.includes(expect) : norm(got).includes(norm(expect)));

    results.push({
      kind,
      case: c.name,
      ok,
      method: r && r.method,
      verified: r && r.verified,
      note: ok ? '' : (r && r.reason) || '内容不匹配: ' + JSON.stringify(got.slice(0, 60))
    });
  }
}

/* ---------------- 聊天框：插入不能触发发送 ---------------- */

let chatResult = { ok: false, note: '' };
try {
  const chatPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  chatPage.on('pageerror', (e) => pageErrors.push('chat pageerror: ' + e.message));
  await chatPage.goto(`http://127.0.0.1:${PORT}/chat.html`, { waitUntil: 'domcontentloaded' });
  await chatPage.waitForFunction(() => window.__chat && window.__chat.ready, null, { timeout: 15000 });
  for (const f of PB_FILES.page) {
    await chatPage.addScriptTag({ path: path.join(ROOT, f) });
  }

  const pre = await chatPage.evaluate(() => window.__WB__.run({ op: 'precheck' }));
  const code = 'function hello() {\n  return 1;\n}\nconst tail = 2;';
  const r = await chatPage.evaluate(
    ({ c }) => window.__WB__.run({ op: 'insert', code: c, choice: 0 }),
    { c: code }
  );
  const sent = await chatPage.evaluate(() => window.__chat.sent.pm + window.__chat.sent.textarea);
  const msgs = await chatPage.evaluate(() => window.__chat.messageCount('pm'));
  const value = await chatPage.evaluate(() => window.__chat.getValue('pm'));

  chatResult.ok = !!(r && r.ok) && sent === 0 && msgs === 0 && String(value).includes('const tail = 2;');
  chatResult.note = `发送 ${sent} 条 · 消息 ${msgs} 条 · ${(r && r.method) || '-'} · ${pre.count} 候选`;
  await chatPage.close();
} catch (e) {
  chatResult.note = e.message;
}
results.push({ kind: 'chat', case: '回车不误触', ok: chatResult.ok, note: chatResult.note });

/* ---------------- Markdown 包裹：只包聊天框，不包代码编辑器 ---------------- */

let mdChat = { ok: false, note: '' };
try {
  const idx = richIndexOf('pm');
  await richPage.evaluate(() => window.__rich.setValue('pm', ''));
  await richPage.evaluate(
    ({ i }) =>
      window.__WB__.run({
        op: 'insert',
        code: 'const a = 1;',
        choice: i,
        md: { on: true, lang: 'js' }
      }),
    { i: idx }
  );
  const got = await richPage.evaluate(() => window.__rich.getValue('pm'));
  mdChat.ok = got.indexOf('```js') === 0 && got.trim().slice(-3) === '```' && got.includes('const a = 1;');
  mdChat.note = JSON.stringify(got);
} catch (e) {
  mdChat.note = e.message;
}
results.push({ kind: 'md', case: '聊天框包裹', ok: mdChat.ok, note: mdChat.note });

let mdCode = { ok: false, note: '' };
try {
  const idx = indexOf('cm6');
  await page.evaluate(() => window.__demo.setValue('cm6', ''));
  await page.evaluate(
    ({ i }) =>
      window.__WB__.run({
        op: 'insert',
        code: 'const b = 2;',
        choice: i,
        md: { on: true, lang: 'js' }
      }),
    { i: idx }
  );
  const got = await page.evaluate(() => window.__demo.getValue('cm6'));
  mdCode.ok = got.includes('const b = 2;') && got.indexOf('```') < 0;
  mdCode.note = JSON.stringify(got);
} catch (e) {
  mdCode.note = e.message;
}
results.push({ kind: 'md', case: '代码框不包裹', ok: mdCode.ok, note: mdCode.note });

/* ---------------- 失败分类字段（v2.1 新增） ---------------- */

{
  const idx = indexOf('cm6');
  await page.evaluate(() => window.__demo.setValue('cm6', ''));
  const r = await page.evaluate(
    ({ i }) => window.__WB__.run({ op: 'insert', code: 'ATTEMPTS_OK', choice: i }),
    { i: idx }
  );
  const ok =
    !!(r && r.ok) && Array.isArray(r.attempts) && r.attempts.length > 0 && r.partial === false;
  results.push({
    kind: 'meta',
    case: 'attempts 字段',
    ok,
    note: JSON.stringify(r && r.attempts)
  });
}

/* ---------------- 盲插：closed shadow DOM ----------------
 * detect() 只穿透 open shadow root，所以这两个框对扩展来说「不存在」。
 * 盲插是它们唯一的机会：execCommand 作用于文档焦点，不受 shadow 边界限制。
 */

let blindResult = { ok: false, note: '' };
try {
  const closedPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  closedPage.on('pageerror', (e) => pageErrors.push('closed pageerror: ' + e.message));
  await closedPage.goto(`http://127.0.0.1:${PORT}/closed.html`, { waitUntil: 'domcontentloaded' });
  await closedPage.waitForFunction(() => window.__closed && window.__closed.ready, null, {
    timeout: 15000
  });
  for (const f of PB_FILES.page) {
    await closedPage.addScriptTag({ path: path.join(ROOT, f) });
  }

  const isClosed = await closedPage.evaluate(() => window.__closed.shadowIsClosed());
  const pre = await closedPage.evaluate(() => window.__WB__.run({ op: 'precheck' }));

  await closedPage.evaluate(() => window.__closed.focusCe());
  const rCe = await closedPage.evaluate(() =>
    window.__WB__.run({ op: 'blind', code: 'BLIND_CE_OK' })
  );
  const ceVal = await closedPage.evaluate(() => window.__closed.getCe());

  await closedPage.evaluate(() => window.__closed.focusTa());
  const rTa = await closedPage.evaluate(() =>
    window.__WB__.run({ op: 'blind', code: 'BLIND_TA_OK' })
  );
  const taVal = await closedPage.evaluate(() => window.__closed.getTa());

  const ok =
    isClosed &&
    pre.count === 0 &&
    ceVal.includes('BLIND_CE_OK') &&
    taVal.includes('BLIND_TA_OK') &&
    rCe.ok === true &&
    rTa.ok === true;

  blindResult.ok = ok;
  blindResult.note =
    `shadow=${isClosed ? 'closed' : 'OPEN?'} · 识别 ${pre.count} 个 · ` +
    `ce=${rCe.verified}/${ceVal.includes('BLIND_CE_OK')} · ` +
    `ta=${rTa.verified}/${taVal.includes('BLIND_TA_OK')}`;
  await closedPage.close();
} catch (e) {
  blindResult.note = e.message;
}
results.push({ kind: 'blind', case: 'closed shadow', ok: blindResult.ok, note: blindResult.note });

/* ---------------- 报告 ---------------- */

await browser.close();
server.close();

console.log('\n结果：');
console.log('─'.repeat(78));
let failed = 0;
for (const r of results) {
  const flag = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) failed++;
  console.log(
    `${flag}  ${r.kind.padEnd(9)} ${String(r.case).padEnd(11)} ` +
      `${(r.method || '-').padEnd(12)} ${r.verified || '-'}` +
      (r.note ? '  ← ' + r.note : '')
  );
}
console.log('─'.repeat(78));
console.log(`${results.length - failed}/${results.length} 通过`);

if (pageErrors.length) {
  const unique = [...new Set(pageErrors.map((e) => e.replace(/\s+/g, ' ').slice(0, 160)))];
  console.log('\n页面错误（去重，最多 6 条）：');
  for (const e of unique.slice(0, 6)) console.log('  ' + e);
  if (unique.length > 6) console.log(`  …另有 ${unique.length - 6} 类`);
}

process.exit(failed ? 1 : 0);
