/* 生成 Edge Add-ons 商店素材
 *
 *   node store/build-assets.mjs
 *
 * 产出 store/assets/：
 *   logo-300.png                300x300   （每个语言必填）
 *   screenshot-1..3-1280x800    1280x800  （可选，最多 6 张）
 *   small-promo-440x280.png     440x280   （可选）
 *   large-promo-1400x560.png    1400x560  （可选）
 *
 * 截图不是画的：真的把扩展装进 Chromium，走一遍「聚焦编辑器 → 弹窗 → 插入」，
 * 拍的是扩展自己的 UI 和页面上的插入结果。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'demo');
const OUT = path.join(ROOT, 'store', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE = `// 两数之和：哈希表一次遍历
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
}`;

const FILLER = {
  cm5: '// CodeMirror 5\nconst cache = new Map();\nfunction memo(fn) {\n  return (k) => cache.get(k) ?? fn(k);\n}',
  cm6: '// CodeMirror 6\nconst state = EditorState.create({\n  doc: "console.log(1)",\n  extensions: [basicSetup]\n});',
  monaco: '// Monaco\nconst model = monaco.editor.createModel(\n  "const x = 1",\n  "javascript"\n);',
  ace: '// Ace\nconst editor = ace.edit("editor");\neditor.session.setMode("ace/mode/js");',
  textarea: '// 普通 textarea\n// 这里模拟一个不允许粘贴的输入框\nconst answer = 42;',
  ce: '// contenteditable\n// 富文本编辑器同样支持插入\nHello, PasteBridge.'
};

/* ---------------- 静态服务器（喂演示页） ---------------- */

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
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

/* ---------------- 装扩展 ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-shot-'));
const extDir = path.join(tmp, 'ext');
fs.mkdirSync(extDir, { recursive: true });
for (const item of ['manifest.json', 'popup', 'page', 'icons']) {
  fs.cpSync(path.join(ROOT, item), path.join(extDir, item), { recursive: true });
}
// 只为截图临时放行本地演示页；正式包不含这条
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

const launchOpts = {
  // 必须用完整 Chromium：headless shell 既打不开 chrome:// 也不加载扩展
  channel: 'chromium',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 1280, height: 680 },
  deviceScaleFactor: 2,
  locale: 'zh-CN'
};

let ctx;
for (const headless of [true, false]) {
  try {
    ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), { headless, ...launchOpts });
    break;
  } catch (e) {
    console.log(`  ${headless ? 'headless' : 'headed'} 启动失败：${e.message.split('\n')[0]}`);
  }
}
if (!ctx) throw new Error('无法启动带扩展的 Chromium');

async function extensionId() {
  const p = await ctx.newPage();
  try {
    await p.goto('chrome://extensions');
    await p.waitForTimeout(1200);
    return await p.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list || !list.shadowRoot) return null;
      for (const it of list.shadowRoot.querySelectorAll('extensions-item')) {
        const id = it.id || it.getAttribute('data-extension-id');
        if (id) return id;
      }
      return null;
    });
  } finally {
    await p.close();
  }
}

const extId = await extensionId();
if (!extId) throw new Error('扩展未加载，读不到 ID');
console.log('→ 扩展 ID =', extId);

/* ---------------- 演示页 ---------------- */

const demo = await ctx.newPage();
await demo.setViewportSize({ width: 1280, height: 680 });
await demo.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
let demoOk = true;
try {
  await demo.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 90000 });
} catch {
  demoOk = false;
  console.log('  ! 演示页编辑器加载超时（CDN 不通？）');
}
if (demoOk) {
  for (const [kind, code] of Object.entries(FILLER)) {
    await demo.evaluate(([k, c]) => window.__demo.setValue(k, c), [kind, code]);
  }
  await demo.waitForTimeout(400);
}

/* ---------------- 弹窗 ---------------- */

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 400, height: 560 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForTimeout(300);

const tabId = await popup.evaluate(async (origin) => {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => (t.url || '').startsWith(origin));
  return hit ? hit.id : null;
}, ORIGIN);

const precheck = () =>
  popup.evaluate(
    async ({ tabId, origin }) => {
      S.tabId = tabId;
      S.url = origin + '/index.html';
      S.origin = origin;
      await precheck();
    },
    { tabId, origin: ORIGIN }
  );

/* 先聚焦编辑器：状态标签会变成绿色的「已聚焦 · CodeMirror 6」，
   比「N 个编辑器 · 插入时选择」更适合当主视觉 */
if (demoOk) {
  await demo.bringToFront();
  await demo.click('#host-cm6 .cm-content');
  await demo.waitForTimeout(200);
}

await precheck();
await popup.fill('#code', SAMPLE);
// 填完内容后 textarea 会滚到底，手动回顶，否则首行被裁掉
await popup.evaluate(() => {
  const t = document.getElementById('code');
  if (t) t.scrollTop = 0;
});
await popup.waitForTimeout(350);
console.log('→ 弹窗状态：', (await popup.textContent('#chip')).trim());

const popupHero = path.join(tmp, 'popup-hero.png');
await popup.screenshot({ path: popupHero });

/* 真实插入一次：拍页面上的结果和提示 */
if (demoOk) {
  await popup.click('#insert');
  await demo.waitForTimeout(1100);
}

const demoShot = path.join(tmp, 'demo.png');
await demo.bringToFront();
await demo.screenshot({ path: demoShot });

/* 再插几次，让「历史」面板有内容可看（这些也都是真插进去的） */
if (demoOk && !popup.isClosed()) {
  const EXTRA = [
    'const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };',
    'SELECT id, name FROM users WHERE created_at > NOW() - INTERVAL 7 DAY;',
    'export const API_BASE = "https://api.example.com/v1";'
  ];
  for (const code of EXTRA) {
    if (popup.isClosed()) break;
    await popup.bringToFront();
    await popup.fill('#code', code);
    await popup.click('#insert').catch(() => {});
    await popup.waitForTimeout(900);
  }
}

/* 历史面板 */
if (!popup.isClosed()) {
  await popup.bringToFront();
  await popup.click('#history').catch(() => {});
  await popup.waitForTimeout(450);
}
const popupHistory = path.join(tmp, 'popup-history.png');
if (!popup.isClosed()) await popup.screenshot({ path: popupHistory });

await ctx.close();
server.close();

/* ---------------- 合成 ---------------- */

const b64 = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
const hero = b64(popupHero);
const hist = fs.existsSync(popupHistory) ? b64(popupHistory) : hero;
const demoImg = demoOk ? b64(demoShot) : null;

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;overflow:hidden}
  body{
    font-family:"Microsoft YaHei","PingFang SC",-apple-system,"Segoe UI",system-ui,sans-serif;
    background:#f6f7fb;color:#0f172a;-webkit-font-smoothing:antialiased;
  }
  .stage{position:relative;width:100%;height:100%;overflow:hidden;
    background:
      radial-gradient(900px 520px at 88% -8%, #e8edff 0%, rgba(232,237,255,0) 62%),
      radial-gradient(760px 480px at 6% 106%, #f1e9ff 0%, rgba(241,233,255,0) 60%),
      linear-gradient(180deg,#fbfcfe 0%,#f2f4f9 100%);}
  .stage:after{content:"";position:absolute;inset:0;pointer-events:none;
    background-image:radial-gradient(#0f172a0d 1px, transparent 1px);
    background-size:22px 22px;mask-image:linear-gradient(180deg,#000 0%,transparent 78%);}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;
    background:#fff;border:1px solid #e4e8f0;color:#475569;font-size:15px;font-weight:600;
    box-shadow:0 2px 10px #0f172a0a;}
  .eyebrow i{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);display:block}
  h1{font-size:64px;line-height:1.12;font-weight:800;letter-spacing:-2px;color:#0b1220}
  h1 em{font-style:normal;background:linear-gradient(120deg,#2563eb,#7c3aed 70%);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{font-size:20px;line-height:1.7;color:#4b5563}
  .sub b{color:#111827}
  .pills{display:flex;flex-wrap:wrap;gap:10px}
  .pills span{padding:9px 15px;border-radius:11px;background:#fff;border:1px solid #e4e8f0;
    font-size:14.5px;color:#334155;font-weight:600;box-shadow:0 2px 8px #0f172a08}
  .pills span:first-child{background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;border-color:transparent}
`;

const shot = async (browser, html, out, w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>${html}`, {
    waitUntil: 'load'
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, out) });
  await page.close();
  console.log('  ✓ ' + out);
};

const browser = await chromium.launch();

/* ---- 截图 1：主视觉 ---- */
await shot(
  browser,
  `<div class="stage">
    <div style="position:absolute;left:76px;top:96px;width:600px">
      <div class="eyebrow"><i></i>Microsoft Edge 扩展</div>
      <h1 style="margin-top:26px">Ctrl+V<br>没反应？<br><em>换条路进去</em></h1>
      <p class="sub" style="margin-top:24px">把代码<b>直接写进</b>编辑器，<br>不经过 paste 事件，所以网站拦不到它。</p>
      <div class="pills" style="margin-top:30px">
        <span>CodeMirror</span><span>Monaco</span><span>Ace</span><span>textarea</span><span>contenteditable</span>
      </div>
    </div>
    <div style="position:absolute;right:118px;top:118px">
      <div style="position:absolute;inset:-14px;border-radius:26px;
        background:linear-gradient(160deg,#2563eb,#7c3aed);opacity:.14;filter:blur(18px)"></div>
      <img src="${hero}" style="position:relative;width:400px;display:block;border-radius:16px;
        border:1px solid #e2e7f0;box-shadow:0 30px 70px -20px rgba(15,23,42,.35),0 8px 24px rgba(15,23,42,.10)">
      <div style="position:absolute;left:-112px;top:56px;background:#fff;border:1px solid #e4e8f0;
        border-radius:12px;padding:10px 16px;font-size:15px;font-weight:700;color:#1d4ed8;
        box-shadow:0 10px 26px rgba(15,23,42,.12)">① 粘贴代码</div>
      <div style="position:absolute;right:-52px;bottom:112px;background:#fff;border:1px solid #e4e8f0;
        border-radius:12px;padding:10px 16px;font-size:15px;font-weight:700;color:#6d28d9;
        box-shadow:0 10px 26px rgba(15,23,42,.12)">② 一键插入</div>
    </div>
  </div>`,
  'screenshot-1-1280x800.png',
  1280,
  800
);

/* ---- 截图 2：真实页面插入结果 ---- */
if (demoImg) {
  await shot(
    browser,
    `<div class="stage">
      <div style="position:absolute;left:0;right:0;top:0;height:128px;padding:30px 56px 0;
        background:linear-gradient(180deg,#ffffff 0%,rgba(255,255,255,0) 100%)">
        <div style="display:flex;align-items:flex-end;justify-content:space-between">
          <div>
            <h1 style="font-size:36px;letter-spacing:-1px">六种编辑器，逐个实测</h1>
            <p class="sub" style="font-size:17px;margin-top:8px">每个都注册了 paste 拦截，插入照样成功 —— 右下角是页面里的结果提示。</p>
          </div>
          <div class="pills" style="padding-bottom:6px"><span>真实扩展环境</span><span>MAIN world</span></div>
        </div>
      </div>
      <img src="${demoImg}" style="position:absolute;left:0;top:120px;width:1280px;display:block;
        border-top:1px solid #e5e9f2;box-shadow:0 -1px 0 #eef1f7">
    </div>`,
    'screenshot-2-1280x800.png',
    1280,
    800
  );
}

/* ---- 截图 3：草稿与历史 ---- */
await shot(
  browser,
  `<div class="stage">
    <div style="position:absolute;left:76px;top:150px;width:590px">
      <div class="eyebrow"><i></i>不丢东西</div>
      <h1 style="margin-top:26px;font-size:52px">关掉弹窗<br>草稿还在</h1>
      <p class="sub" style="margin-top:24px">插入时页面会抢走焦点，弹窗常常自己关掉。<br>草稿自动保存，最近 10 次插入随时取回。</p>
      <div class="pills" style="margin-top:30px">
        <span>自动保存草稿</span><span>最近 10 段</span><span>一键回填</span>
      </div>
    </div>
    <div style="position:absolute;right:126px;top:118px">
      <div style="position:absolute;inset:-14px;border-radius:26px;
        background:linear-gradient(160deg,#7c3aed,#2563eb);opacity:.14;filter:blur(18px)"></div>
      <img src="${hist}" style="position:relative;width:400px;display:block;border-radius:16px;
        border:1px solid #e2e7f0;box-shadow:0 30px 70px -20px rgba(15,23,42,.35),0 8px 24px rgba(15,23,42,.10)">
    </div>
  </div>`,
  'screenshot-3-1280x800.png',
  1280,
  800
);

/* ---- 宣传图 ---- */
const ICON_SVG = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#6d28d9"/>
  </linearGradient></defs>
  <rect width="300" height="300" rx="67.5" fill="url(#g)"/>
  <rect x="136.5" y="67.5" width="27" height="102" rx="4.5" fill="#fff"/>
  <path d="M94.5 154.5 H205.5 L150 214.5 Z" fill="#fff"/>
  <rect x="88.5" y="229.5" width="123" height="18" rx="9" fill="#fff"/>
</svg>`;

await shot(
  browser,
  `<div style="position:absolute;inset:0;background:linear-gradient(135deg,#1d4ed8 0%,#4f46e5 52%,#6d28d9 100%)"></div>
   <div style="position:absolute;inset:0;background:
      radial-gradient(420px 260px at 86% 8%,rgba(255,255,255,.22),transparent 70%),
      radial-gradient(360px 240px at 8% 96%,rgba(255,255,255,.14),transparent 70%)"></div>
   <div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;
      padding-left:40px">
     ${ICON_SVG(76)}
     <div style="margin-top:22px;color:#fff;font-size:34px;font-weight:800;letter-spacing:-0.8px;line-height:1.1">
       贴进去<span style="font-size:17px;font-weight:600;opacity:.78;margin-left:9px">PasteBridge</span></div>
     <div style="margin-top:12px;color:#dfe6ff;font-size:15px;line-height:1.55;max-width:340px">
       粘贴被禁用时，把代码直接插进编辑器</div>
   </div>`,
  'small-promo-440x280.png',
  440,
  280
);

await shot(
  browser,
  `<div style="position:absolute;inset:0;background:linear-gradient(120deg,#1e40af 0%,#4338ca 46%,#6d28d9 100%)"></div>
   <div style="position:absolute;inset:0;background:
      radial-gradient(700px 420px at 84% 4%,rgba(255,255,255,.20),transparent 68%),
      radial-gradient(560px 380px at 4% 100%,rgba(255,255,255,.13),transparent 68%)"></div>
   <div style="position:absolute;inset:0;display:flex;align-items:center;padding-left:96px;gap:44px">
     ${ICON_SVG(148)}
     <div>
       <div style="color:#fff;font-size:64px;font-weight:800;letter-spacing:-2.4px;line-height:1.06">
         贴进去 <span style="opacity:.72;font-weight:600;font-size:37px">PasteBridge</span></div>
       <div style="color:#dbe3ff;font-size:24px;margin-top:16px;line-height:1.55">
         Ctrl+V 没反应的时候，把代码直接写进编辑器</div>
       <div style="display:flex;gap:12px;margin-top:26px">
         <span style="padding:9px 18px;border-radius:10px;background:rgba(255,255,255,.16);
           border:1px solid rgba(255,255,255,.3);color:#fff;font-size:17px;font-weight:600">CodeMirror 5/6</span>
         <span style="padding:9px 18px;border-radius:10px;background:rgba(255,255,255,.16);
           border:1px solid rgba(255,255,255,.3);color:#fff;font-size:17px;font-weight:600">Monaco</span>
         <span style="padding:9px 18px;border-radius:10px;background:rgba(255,255,255,.16);
           border:1px solid rgba(255,255,255,.3);color:#fff;font-size:17px;font-weight:600">Ace</span>
         <span style="padding:9px 18px;border-radius:10px;background:rgba(255,255,255,.16);
           border:1px solid rgba(255,255,255,.3);color:#fff;font-size:17px;font-weight:600">textarea</span>
       </div>
     </div>
   </div>`,
  'large-promo-1400x560.png',
  1400,
  560
);

/* ---- Logo 300x300（透明背景，圆角外留空） ---- */
const logoPage = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
await logoPage.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${ICON_SVG(300)}`);
await logoPage.screenshot({ path: path.join(OUT, 'logo-300.png'), omitBackground: true });
await logoPage.close();
console.log('  ✓ logo-300.png');

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

/* ---- 尺寸自检 ---- */
const { execFileSync } = await import('node:child_process');
console.log('\n素材尺寸：');
for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.png'))) {
  const buf = fs.readFileSync(path.join(OUT, f));
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  console.log(`  ${f.padEnd(30)} ${w}x${h}  ${(buf.length / 1024).toFixed(1)} KB`);
}
