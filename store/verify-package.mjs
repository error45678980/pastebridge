/* 校验「要提交的那个 zip」本身能不能被浏览器加载
 *
 *   node store/verify-package.mjs <解压后的目录>
 *
 * 审的不是源码目录，是 zip 解出来的东西 —— 万一打包脚本漏了文件，
 * 这一步会当场暴露，而不是等审核员告诉你。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node store/verify-package.mjs <解压目录>');
  process.exit(2);
}

const fail = [];
const ok = (msg) => console.log('  PASS  ' + msg);
const bad = (msg) => { console.log('  FAIL  ' + msg); fail.push(msg); };

/* ---------- 静态检查 ---------- */

console.log('\n[1] 包结构');
const manifestPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) bad('manifest.json 不在根目录');
else ok('manifest.json 位于根目录');

const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (mf.manifest_version === 3) ok('manifest_version = 3');
else bad('manifest_version 不是 3');

if (/^\d+(\.\d+){0,3}$/.test(mf.version || '')) ok('version 合法: ' + mf.version);
else bad('version 格式不对: ' + mf.version);

for (const key of ['16', '32', '48', '128']) {
  const p = path.join(dir, mf.icons?.[key] || '');
  if (mf.icons?.[key] && fs.existsSync(p)) ok(`图标 ${key} 存在 (${mf.icons[key]})`);
  else bad(`图标 ${key} 缺失`);
}

const popupPath = path.join(dir, mf.action?.default_popup || '');
if (mf.action?.default_popup && fs.existsSync(popupPath)) ok('popup 页面存在');
else bad('popup 页面缺失');

if (!mf.host_permissions) ok('没有 host_permissions（权限最小化，审核加分）');
else bad('存在 host_permissions，审核时要额外解释');

const ALLOWED = ['scripting', 'activeTab', 'storage', 'contextMenus', 'debugger'];
for (const p of mf.permissions || []) {
  if (p === 'debugger') {
    console.log('  WARN  内置 debugger（增强版）：安装时会多一条「访问页面调试器后端」警告');
  } else if (ALLOWED.includes(p)) ok('权限合理: ' + p);
  else bad('出现了意料之外的权限: ' + p);
}

const ALLOWED_OPT = ['clipboardRead', 'clipboardWrite', 'debugger'];
for (const p of mf.optional_permissions || []) {
  if (p === 'debugger') {
    // Chrome 会静默丢弃它，运行时申请必定失败，这里提前拦住
    bad('debugger 不能作为可选权限（Chrome 会丢弃），请用 --with-debugger 打包');
  } else if (ALLOWED_OPT.includes(p)) ok('可选权限合理: ' + p);
  else bad('出现了意料之外的可选权限: ' + p);
}

if ((mf.optional_host_permissions || []).length) {
  ok('可选 host 权限已声明（仅在用户主动开启时申请）');
}

// 背景服务脚本必须存在，且 importScripts 引用的文件要一起打进包
const sw = mf.background && mf.background.service_worker;
if (sw && fs.existsSync(path.join(dir, sw))) ok('service worker 存在: ' + sw);
else bad('service worker 缺失: ' + (sw || '(manifest 未声明)'));

const swSrc = sw ? fs.readFileSync(path.join(dir, sw), 'utf8') : '';
for (const m of swSrc.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
    const rel = q[1].replace(/^\//, '');
    if (fs.existsSync(path.join(dir, rel))) ok('importScripts 目标存在: ' + rel);
    else bad('importScripts 目标缺失: ' + rel);
  }
}

// popup 引用的脚本/样式必须都在包里
const popupHtml = fs.readFileSync(popupPath, 'utf8');
for (const m of popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const rel = m[1];
  if (/^(https?:|data:)/.test(rel)) { bad('popup 引用了外部资源: ' + rel); continue; }
  const p = path.join(path.dirname(popupPath), rel);
  if (fs.existsSync(p)) ok('popup 依赖齐全: ' + rel);
  else bad('popup 依赖缺失: ' + rel);
}

// page/ 下的注入脚本应全部在包内
const need = ['core.js', 'specs.js', 'detect.js', 'methods.js', 'insert.js', 'picker.js', 'main.js'];
for (const f of need) {
  const p = path.join(dir, 'page', f);
  if (fs.existsSync(p)) ok('注入脚本存在: page/' + f);
  else bad('注入脚本缺失: page/' + f);
}

// 工作台是独立页面，缺了它「工作台」按钮会 404
for (const f of [
  'workbench/index.html',
  'workbench/workbench.js',
  'workbench/workbench.css',
  'lib/store.js',
  'lib/files.js',
  'lib/typing.js',
  'lib/cdp.js'
]) {
  if (fs.existsSync(path.join(dir, f))) ok('运行时文件存在: ' + f);
  else bad('运行时文件缺失: ' + f);
}

/* ---------- 真实加载 ---------- */

console.log('\n[2] 浏览器加载');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-verify-'));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
  });
  ok('Chromium 已加载该目录（没有加载失败）');
} catch (e) {
  bad('浏览器启动失败: ' + e.message.split('\n')[0]);
  process.exit(1);
}

const p = await ctx.newPage();
await p.goto('chrome://extensions');
await p.waitForTimeout(1200);
const id = await p.evaluate(() => {
  const mgr = document.querySelector('extensions-manager');
  const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
  if (!list || !list.shadowRoot) return null;
  const it = list.shadowRoot.querySelector('extensions-item');
  return it ? (it.id || it.getAttribute('data-extension-id')) : null;
});
await p.close();

if (!id) bad('扩展没有被注册（manifest 有误？）');
else ok('扩展 ID = ' + id);

if (id) {
  const popup = await ctx.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(e.message));
  popup.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await popup.goto(`chrome-extension://${id}/${mf.action.default_popup}`);
  await popup.waitForTimeout(1200);

  const title = await popup.title();
  ok('popup 已渲染，标题: ' + title);

  const chip = (await popup.textContent('#chip').catch(() => '') || '').trim();
  if (chip && chip !== '检测中…') ok('状态标签有反馈: 「' + chip + '」');
  else bad('状态标签停在初始态，可能 popup.js 没跑起来');

  const hasInsert = await popup.$('#insert');
  if (hasInsert) ok('插入按钮存在');
  else bad('插入按钮缺失');

  // 后台页（MV3 无 service worker，这里只确认没有额外报错）
  const real = errors.filter((e) => !/favicon|net::ERR_FILE/i.test(e));
  if (!real.length) ok('popup 无 JS 报错');
  else real.slice(0, 3).forEach((e) => bad('popup 报错: ' + e.slice(0, 160)));

  await popup.close();
}

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });

console.log('\n' + (fail.length ? `✗ ${fail.length} 项未通过` : '✓ 全部通过，这个包可以直接上传'));
process.exit(fail.length ? 1 : 0);
