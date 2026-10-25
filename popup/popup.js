'use strict';

/* 贴进去 · PasteBridge — 弹窗逻辑
 *
 * 弹窗只负责界面：预检、草稿、历史、状态呈现。
 * 注入与执行全部交给 background/sw.js —— 插入时页面会抢焦点、弹窗随之关闭，
 * 留在弹窗里的那条 promise 只会以 "message port closed" 收场，结果拿不回来。
 */

const $ = (id) => document.getElementById(id);

const ui = {
  code: $('code'),
  count: $('count'),
  saved: $('saved'),
  chip: $('chip'),
  insert: $('insert'),
  typeIt: $('typeIt'),
  history: $('history'),
  snippets: $('snippets'),
  workbench: $('workbench'),
  readClip: $('readClip'),
  clear: $('clear'),
  md: $('md'),
  panel: $('panel'),
  panelTitle: $('panelTitle'),
  list: $('list'),
  closePanel: $('closePanel'),
  framePanel: $('framePanel'),
  frameList: $('frameList'),
  closeFramePanel: $('closeFramePanel'),
  hint: $('hint')
};

const S = {
  tabId: null,
  url: '',
  origin: 'null',
  world: 'MAIN',
  pre: null,
  lastChoice: null,
  busy: false,
  saveTimer: 0,
  fileBlocked: false,
  panelMode: 'history',
  md: { on: false, lang: '' },
  typing: {},
  lastFail: null,
  pendingType: false,
  /* 跨 frame：frames 是各帧概况，targets 是合并后的候选（带 frameId） */
  frames: [],
  targets: [],
  frameId: null
};

/* ---------------- 初始化 ---------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bind();
  await restoreDraft();
  updateCount();
  await loadSettings();

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {}

  if (!tab || tab.id == null) {
    setChip('err', '没有活动标签页');
    return;
  }

  S.tabId = tab.id;
  S.url = tab.url || '';
  S.origin = originOf(S.url);

  // 记下目标页：工作台里的「插入页面」要靠它
  try {
    await chrome.storage.session.set({ lastTabId: S.tabId, lastUrl: S.url });
  } catch (_) {}

  if (S.url && !/^(https?|file):/i.test(S.url)) {
    setChip('err', '此页面不支持扩展运行');
    ui.insert.disabled = true;
    return;
  }

  await precheck();
  ui.code.focus();
}

function bind() {
  ui.code.addEventListener('input', () => {
    updateCount();
    scheduleDraftSave();
  });

  ui.code.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doInsert();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // 浮层开着时先收浮层，再按一次才关窗口
      if (!ui.panel.classList.contains('hidden')) {
        ui.panel.classList.add('hidden');
        return;
      }
      if (!ui.framePanel.classList.contains('hidden')) {
        ui.framePanel.classList.add('hidden');
        return;
      }
      window.close();
    }
  });

  ui.insert.addEventListener('click', doInsert);
  ui.clear.addEventListener('click', () => {
    ui.code.value = '';
    updateCount();
    scheduleDraftSave();
    ui.code.focus();
  });

  ui.history.addEventListener('click', () => openPanel('history'));
  ui.snippets.addEventListener('click', () => openPanel('snippets'));
  ui.workbench.addEventListener('click', () => openWorkbench());
  ui.readClip.addEventListener('click', readClipboardIntoEditor);
  ui.md.addEventListener('click', toggleMd);
  ui.typeIt.addEventListener('click', doType);

  ui.closePanel.addEventListener('click', () => ui.panel.classList.add('hidden'));
  ui.closeFramePanel.addEventListener('click', () => ui.framePanel.classList.add('hidden'));

  // 点状态胶囊 = 重新检测；强制扫描内嵌框架（顶层有编辑器时也能扫）
  ui.chip.addEventListener('click', () => {
    if (S.busy) return;
    precheck(true);
  });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return 'null';
  }
}

/* ---------------- 与背景层通信 ---------------- */

/** 所有页面操作都经由 SW，弹窗中途关闭也不会中断执行 */
async function run(payload, frameIds) {
  const msg = { type: 'pb:run', tabId: S.tabId, payload };
  if (frameIds && frameIds.length) msg.frameIds = frameIds;
  const r = await chrome.runtime.sendMessage(msg);
  if (!r) return { ok: false, reason: 'no-response' };
  if (r.world) S.world = r.world;
  return r;
}

/* ---------------- 预检 ---------------- */

async function precheck(forceScan) {
  setChip('idle', '检测中…');
  try {
    let r = await run({ op: 'precheck' });

    if (!r || !r.ok) {
      const failed = r && r.reason === 'inject-failed';
      setChip('err', failed ? '注入失败，请刷新页面' : '无法访问此页面');
      ui.insert.disabled = true;
      return;
    }

    S.frames = [];
    S.targets = [];
    S.frameId = null;

    /* 顶层找不到编辑器、而页面里有 iframe —— 编辑器很可能藏在子帧里。
     * 点状态胶囊可以强制扫描一次（顶层也有编辑器时用得上）。 */
    const wantScan = !!(r.iframes && (forceScan || !r.count));
    if (wantScan) {
      setChip('idle', '扫描内嵌框架…');
      let s = null;
      try {
        s = await run({ op: 'scan' });
      } catch (_) {}
      if (s && s.ok && s.count) {
        S.frames = s.frames || [];
        S.targets = s.choices || [];
        r = {
          ok: true,
          count: s.count,
          choices: s.choices,
          primary: null,
          focused: s.choices.some((c) => c.focused),
          iframes: r.iframes,
          scanned: true
        };
        if (s.world) S.world = s.world;
      }
    }

    S.pre = r;

    if (r.picked) {
      S.lastChoice = r.picked;
      saveChoice(r.picked);
    } else {
      S.lastChoice = await loadChoice();
    }

    if (!r.count) {
      ui.insert.disabled = true;
      const why = r.iframes ? '未找到编辑器（' + r.iframes + ' 个 iframe 也扫过了）' : '未找到编辑器';
      setChip('warn', why);
    } else {
      ui.insert.disabled = false;
      const primary = r.primary != null ? r.choices[r.primary] : r.choices[0];
      const name = primary && primary.name ? ' · ' + primary.name : '';
      let text;
      if (r.scanned) {
        text =
          S.frames.length > 1
            ? '内嵌 ' + S.frames.length + ' 个框架 · ' + r.count + ' 个编辑器'
            : '内嵌框架 · ' + (primary ? primary.label + name : r.count + ' 个编辑器');
      } else if (r.count === 1) {
        text = primary.label + name + ' · 就绪';
      } else if (r.focused) {
        text = '已聚焦 ' + primary.label + name;
      } else {
        text = r.count + ' 个编辑器 · 插入时选择';
      }
      setChip(r.count === 1 || r.focused ? 'ok' : 'warn', text);
      if (S.world === 'ISOLATED') setChip('warn', text + ' · 降级');
    }

    if (r.lastStatus) showLast(r.lastStatus);
  } catch (e) {
    setChip('err', mapError(e));
    ui.insert.disabled = true;
    if (/file:/i.test(S.url)) {
      ui.hint.textContent = 'file:// 页面需要在扩展详情里开启「允许访问文件网址」';
    }
  }
}

function showLast(st) {
  if (!st) return;
  const when = st.ok ? '上次：✓ ' : '上次：✕ ';
  const detail = st.ok ? st.chars + ' 字符' : st.reason || '失败';
  ui.saved.textContent = when + detail;
  ui.saved.classList.add('show');
  setTimeout(() => ui.saved.classList.remove('show'), 4000);
}

/* ---------------- 插入 ---------------- */

const NEED_PICK = Symbol('need-pick');

/* 目标帧怎么定：聚焦的那一帧 > 只有一帧有候选 > 让用户选 */
function resolveFrame() {
  const targets = S.targets;
  if (!targets.length) return S.frameId;

  const focused = targets.filter((t) => t.focused && !t.readonly);
  if (focused.length) return focused[0].frameId;

  const ids = [...new Set(targets.map((t) => t.frameId))];
  if (ids.length === 1) return ids[0];
  return NEED_PICK;
}

function renderFrameChooser() {
  ui.frameList.textContent = '';

  const byFrame = new Map();
  for (const t of S.targets) {
    if (!byFrame.has(t.frameId)) byFrame.set(t.frameId, []);
    byFrame.get(t.frameId).push(t);
  }

  let i = 0;
  for (const [frameId, list] of byFrame) {
    i++;
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';

    const title = document.createElement('div');
    title.className = 'item-preview';
    const where = list[0].isTop ? '主页面' : '内嵌框架 ' + i;
    title.textContent =
      where + ' · ' + list.map((c) => c.label + (c.name ? '（' + c.name + '）' : '')).join(' / ');

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = list.length + ' 个可插入位置' + (list.every((c) => c.readonly) ? ' · 只读' : '');

    main.appendChild(title);
    main.appendChild(sub);
    li.appendChild(main);

    li.addEventListener('click', () => {
      S.frameId = frameId;
      insertNow(ui.code.value, frameId);
    });

    ui.frameList.appendChild(li);
  }

  ui.framePanel.classList.remove('hidden');
}

async function doInsert() {
  const code = ui.code.value;
  if (!code) {
    setChip('warn', '先粘贴点代码');
    ui.code.focus();
    return;
  }
  if (S.busy) return;
  if (S.tabId == null) {
    setChip('err', '没有活动标签页');
    return;
  }

  const frame = resolveFrame();
  if (frame === NEED_PICK) {
    setChip('warn', '请选择要插入的位置');
    renderFrameChooser();
    return;
  }

  await insertNow(code, frame);
}

async function insertNow(code, frameId) {
  S.busy = true;
  ui.insert.disabled = true;
  ui.framePanel.classList.add('hidden');
  setChip('idle', '正在插入…');

  try {
    const r = await run(
      { op: 'insert', code, lastChoice: S.lastChoice, md: S.md },
      frameId == null ? null : [frameId]
    );

    if (!r) {
      setChip('err', '页面无响应，请刷新后重试');
      return;
    }

    if (r.pending) {
      setChip('warn', '请在页面选择编辑器（' + r.count + ' 个）');
      return;
    }

    if (r.ok) {
      if (r.partial) {
        // 方法中途抛异常但内容变了：不敢说成功，也不敢再打一遍
        setChip('warn', '可能只插入了一部分，请检查');
        hideTypeButton();
        return;
      }
      const tag = r.verified === 'strict' ? '' : r.verified === 'weak' ? ' · 弱校验' : ' · 未校验';
      const flat = r.flat ? ' · 换行已转空格' : '';
      setChip('ok', '✓ 已插入 ' + r.chars + ' 字符' + tag + flat);
      hideTypeButton();
      // 插入记录由 SW 就地写入（弹窗随时可能被关掉），这里不用再写一遍
    } else {
      S.lastFail = r;
      setChip('err', mapReason(r.reason));
      showTypeButton();
      if (S.typing && S.typing.autoFallback) S.pendingType = true;
    }
  } catch (e) {
    // 插入时页面会抢走焦点，弹窗随之关闭，promise 以 "message port closed" 结束。
    // 这是预期行为：结果已经在页面右下角提示了。
    const msg = String((e && e.message) || e || '');
    if (/port closed|message port|窗口|closed/i.test(msg)) {
      setChip('idle', '已发送，结果见页面提示');
    } else {
      setChip('err', mapError(e));
    }
  } finally {
    S.busy = false;
    ui.insert.disabled = !(S.pre && S.pre.count);
  }

  // 自动兜底要等 busy 复位之后再跑，否则 doType 会直接 return
  if (S.pendingType) {
    S.pendingType = false;
    doType();
  }
}

function mapReason(reason) {
  if (!reason) return '插入失败';
  if (reason === 'no-editor') return '没有找到可插入的编辑器';
  if (reason === 'empty') return '没有内容可插入';
  if (reason === 'debugger-denied') return '当前安装包不含键盘模拟（需增强版）';
  if (reason === 'debugger-unavailable') return '当前安装包不含键盘模拟（需增强版）';
  if (reason === 'debugger-busy') return '调试器被占用，请关闭开发者工具';
  if (reason === 'debugger-detached') return '调试会话被中断';
  if (reason === 'timeout') return '键入超时，可能只打了一部分';
  if (reason === 'cdp-failed') return '键盘模拟失败';
  if (reason === 'too-long') return '内容太长，无法逐字键入';
  if (reason === 'no-focus') return '页面上没有可键入的焦点';
  if (reason === 'blind-no-change') return '盲插没有产生变化';
  return String(reason).slice(0, 80);
}

function mapError(e) {
  const m = String((e && e.message) || e || '');
  if (/Cannot access contents of the page|Cannot access a chrome|extensions gallery|Web Store/i.test(m)) {
    return /file:/i.test(S.url) ? '无权限：请在扩展详情里允许访问文件网址' : '此页面不允许扩展运行';
  }
  if (/No tab with id|Invalid tab ID|tab was closed/i.test(m)) return '标签页已关闭';
  if (/Missing host permission|Cannot access contents/i.test(m)) return '无权限访问此页面';
  if (/message port closed/i.test(m)) return '窗口已关闭';
  return m.slice(0, 80) || '未知错误';
}

/* ---------------- 状态条 ---------------- */

function setChip(kind, text) {
  ui.chip.className = 'chip' + (kind && kind !== 'idle' ? ' ' + kind : '');
  ui.chip.textContent = text;
}

/* ---------------- 草稿 ---------------- */

function updateCount() {
  const v = ui.code.value;
  const lines = v ? v.split('\n').length : 0;
  ui.count.textContent = v.length + ' 字符 · ' + lines + ' 行';
}

function scheduleDraftSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveDraft, 300);
}

async function saveDraft() {
  const code = ui.code.value.slice(0, 200000);
  try {
    await chrome.storage.local.set({ draft: { code, ts: Date.now() } });
    ui.saved.textContent = '草稿已保存';
    ui.saved.classList.add('show');
    setTimeout(() => {
      if (ui.saved.textContent === '草稿已保存') ui.saved.classList.remove('show');
    }, 1400);
  } catch (_) {}
}

async function restoreDraft() {
  try {
    const { draft } = await chrome.storage.local.get('draft');
    if (draft && draft.code) ui.code.value = draft.code;
  } catch (_) {}
}

/* ---------------- 剪贴板面板 ---------------- */

function openPanel(mode) {
  S.panelMode = mode;
  ui.panelTitle.textContent = mode === 'snippets' ? '片段库' : '剪贴板历史';
  ui.panel.classList.remove('hidden');
  if (mode === 'snippets') renderSnippets();
  else renderHistory();
}

function emptyLi(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function loadIntoEditor(text) {
  ui.code.value = text;
  updateCount();
  scheduleDraftSave();
  ui.panel.classList.add('hidden');
  ui.code.focus();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // 扩展页里 execCommand 通常不需要额外权限，作为兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    return ok;
  }
}

async function renderHistory() {
  const idx = await PBStore.getClipIndex();
  ui.list.textContent = '';

  if (!idx.length) {
    ui.list.appendChild(
      emptyLi('还没有记录。\n复制内容后点「读剪贴板」，或用工作台抓取页面选区。')
    );
    return;
  }

  for (const c of idx.slice(0, 30)) {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';

    const prev = document.createElement('div');
    prev.className = 'item-preview';
    prev.textContent = (c.pin ? '★ ' : '') + c.preview;

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent =
      c.len + ' 字符 · ' + (c.src && c.src.host ? c.src.host + ' · ' : '') + fmtTime(c.ts);

    main.appendChild(prev);
    main.appendChild(sub);

    const copy = document.createElement('button');
    copy.className = 'item-del';
    copy.textContent = '⧉';
    copy.title = '复制到系统剪贴板';
    copy.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = await PBStore.getClipText(c.id);
      const ok = await copyText(text);
      setChip(ok ? 'ok' : 'err', ok ? '已复制到剪贴板' : '复制失败');
    });

    const del = document.createElement('button');
    del.className = 'item-del';
    del.textContent = '×';
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await PBStore.removeClip(c.id);
      renderHistory();
    });

    li.appendChild(main);
    li.appendChild(copy);
    li.appendChild(del);
    li.addEventListener('click', async () => {
      const text = await PBStore.getClipText(c.id);
      loadIntoEditor(text);
    });

    ui.list.appendChild(li);
  }
}

async function renderSnippets() {
  const idx = await PBStore.getSnipIndex();
  ui.list.textContent = '';

  if (!idx.length) {
    ui.list.appendChild(emptyLi('还没有片段。\n到工作台里把常用代码块存成片段，之后一键取用。'));
    return;
  }

  for (const s of idx) {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';

    const prev = document.createElement('div');
    prev.className = 'item-preview';
    prev.textContent = s.name + (s.lang ? ' · ' + s.lang : '');

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    sub.textContent = s.len + ' 字符 · 用过 ' + (s.used || 0) + ' 次';

    main.appendChild(prev);
    main.appendChild(sub);
    li.appendChild(main);

    li.addEventListener('click', async () => {
      const text = await PBStore.getSnippetText(s.id);
      await PBStore.useSnippet(s.id);
      loadIntoEditor(text);
    });

    ui.list.appendChild(li);
  }
}

/* 读系统剪贴板进输入框：最直接的「当剪贴板用」 */
async function readClipboardIntoEditor() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setChip('warn', '剪贴板是空的');
      return;
    }
    loadIntoEditor(text);
    await PBStore.putClip({ text, src: { host: 'clipboard' } });
    setChip('ok', '已读入 ' + text.length + ' 字符');
  } catch (_) {
    setChip('err', '需要剪贴板权限（工作台 → 设置 里申请）');
  }
}

/* 只接受字符串形式的 hash。
 * 这个函数既被 click 直接绑定（此时第一个参数是 MouseEvent），
 * 也被显式传 '#settings' 调用——不挡一道就会拼出
 * "workbench/index.html[object MouseEvent]" 这种不存在的路径。 */
function workbenchUrl(hash) {
  const suffix = typeof hash === 'string' && hash.charAt(0) === '#' ? hash : '';
  return chrome.runtime.getURL('workbench/index.html' + suffix);
}

function openWorkbench(hash) {
  chrome.tabs.create({ url: workbenchUrl(hash) });
}

function fmtTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  const d = new Date(ts);
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

/* ---------------- 设置与 Markdown 开关 ---------------- */

async function loadSettings() {
  try {
    const st = await PBStore.getSettings();
    S.md = st.md || { on: false, lang: '' };
    S.typing = st.typing || {};
  } catch (_) {}
  paintMd();
}

function paintMd() {
  ui.md.className = 'linkbtn' + (S.md.on ? ' on' : '');
  ui.md.title = S.md.on
    ? '已开启：插到聊天框时会包成 ``` 代码块（点击关闭）'
    : '插到聊天框 / 富文本框时包成 ``` 代码块';
}

async function toggleMd() {
  S.md = { on: !S.md.on, lang: S.md.lang || '' };
  paintMd();
  try {
    await PBStore.saveSettings({ md: { on: S.md.on } });
  } catch (_) {}
}

/* ---------------- 键入：盲插 → 键盘模拟 ---------------- */

async function hasDebuggerPerm() {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch (_) {
    return false;
  }
}

function showTypeButton() {
  ui.typeIt.classList.remove('hidden');
}

function hideTypeButton() {
  ui.typeIt.classList.add('hidden');
  S.lastFail = null;
}

/**
 * 失败后的兜底路由：
 *   no-editor（连候选都没有）→ 先盲插，盲插无效再键盘模拟
 *   有目标但所有方法都失败 → 跳过盲插（execCommand 已经试过），直接键盘模拟
 */
async function doType() {
  const code = ui.code.value;
  if (!code) {
    setChip('warn', '先粘贴点内容');
    return;
  }
  if (S.busy) return;

  const reason = S.lastFail && S.lastFail.reason;

  if (reason === 'no-editor') {
    S.busy = true;
    setChip('idle', '正在盲插…');
    let b = null;
    try {
      b = await run({ op: 'blind', code });
    } catch (_) {}
    S.busy = false;

    if (b && b.ok && b.verified === 'strict') {
      setChip('ok', '✓ 已盲插 ' + b.chars + ' 字符');
      hideTypeButton();
      return;
    }
    if (b && b.ok && b.verified === 'uncertain') {
      setChip('warn', '已尝试盲插（未校验），请检查；没效果再点一次');
      return;
    }
  }

  if (!(await hasDebuggerPerm())) {
    // Chrome 不允许 debugger 作为可选权限，只能在「增强版」安装包里内置
    setChip('warn', '当前安装包不含键盘模拟（需增强版）');
    return;
  }

  await typeNow(code);
}

async function typeNow(code) {
  S.busy = true;
  ui.insert.disabled = true;
  setChip('idle', '正在键入…');

  try {
    const r = await run({ op: 'type', code, choice: S.lastChoice || null });

    if (!r) {
      setChip('err', '页面无响应，请刷新后重试');
      return;
    }
    if (r.ok) {
      const cut = r.truncated ? '（超出上限，已截断）' : '';
      setChip('ok', '✓ 已键入 ' + r.chars + ' 字符' + cut);
      hideTypeButton();
    } else {
      setChip('err', mapReason(r.reason));
    }
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (/port closed|message port|窗口|closed/i.test(msg)) {
      setChip('idle', '已发送，结果见页面提示');
    } else {
      setChip('err', mapError(e));
    }
  } finally {
    S.busy = false;
    ui.insert.disabled = !(S.pre && S.pre.count);
  }
}

/* ---------------- 站点记忆 ---------------- */

async function loadChoice() {
  try {
    const s = await PBStore.getSite(S.origin);
    return s ? { kind: s.kind, nth: s.nth } : null;
  } catch (_) {
    return null;
  }
}

async function saveChoice(choice) {
  try {
    await PBStore.setSite(S.origin, { kind: choice.kind, nth: choice.nth, frameId: S.frameId });
  } catch (_) {}
}
