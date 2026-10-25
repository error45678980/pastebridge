'use strict';

/* 贴进去 · PasteBridge — 弹窗逻辑
 *
 * 弹窗只做三件事：预检（顺带快照焦点）、把代码交给页面世界、记录草稿与历史。
 * 插入的真正执行发生在页面里，所以弹窗中途关闭不会中断插入。
 */

const PAGE_FILES = ['page/core.js', 'page/detect.js', 'page/insert.js', 'page/picker.js', 'page/main.js'];

const $ = (id) => document.getElementById(id);

const ui = {
  code: $('code'),
  count: $('count'),
  saved: $('saved'),
  chip: $('chip'),
  insert: $('insert'),
  history: $('history'),
  clear: $('clear'),
  panel: $('panel'),
  list: $('list'),
  closePanel: $('closePanel'),
  hint: $('hint')
};

const S = {
  tabId: null,
  url: '',
  origin: 'null',
  world: 'MAIN',
  pre: null,
  lastChoice: null,
  history: [],
  busy: false,
  saveTimer: 0,
  fileBlocked: false
};

/* ---------------- 初始化 ---------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bind();
  await restoreDraft();
  updateCount();

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
      // 历史面板开着时先收面板，再按一次才关窗口
      if (!ui.panel.classList.contains('hidden')) {
        ui.panel.classList.add('hidden');
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

  ui.history.addEventListener('click', () => {
    renderHistory();
    ui.panel.classList.remove('hidden');
  });

  ui.closePanel.addEventListener('click', () => ui.panel.classList.add('hidden'));

  // 点状态胶囊 = 重新检测（比如刚在页面里点了编辑器）
  ui.chip.addEventListener('click', () => {
    if (S.busy) return;
    precheck();
  });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return 'null';
  }
}

/* ---------------- 与页面世界通信 ---------------- */

async function ensureInjected() {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: S.tabId },
      files: PAGE_FILES,
      world: 'MAIN'
    });
    S.world = 'MAIN';
    return;
  } catch (_) {
    // 少数站点会拒绝主世界注入，降级到隔离世界（失去原生实例 API，但 execCommand 仍可用）
  }
  await chrome.scripting.executeScript({ target: { tabId: S.tabId }, files: PAGE_FILES });
  S.world = 'ISOLATED';
}

async function run(payload) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: S.tabId },
    world: S.world,
    func: (p) => (window.__WB__ ? window.__WB__.run(p) : { ok: false, reason: 'inject-failed' }),
    args: [payload]
  });
  return res && res.result;
}

/* ---------------- 预检 ---------------- */

async function precheck() {
  setChip('idle', '检测中…');
  try {
    await ensureInjected();
    const r = await run({ op: 'precheck' });

    if (!r || !r.ok) {
      setChip('err', r && r.reason === 'inject-failed' ? '注入失败，请刷新页面' : '无法访问此页面');
      ui.insert.disabled = true;
      return;
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
      setChip('warn', r.iframes ? '未找到编辑器（可能在 iframe 中）' : '未找到编辑器');
    } else {
      ui.insert.disabled = false;
      const primary = r.primary != null ? r.choices[r.primary] : r.choices[0];
      const name = primary.name ? ' · ' + primary.name : '';
      let text;
      if (r.count === 1) text = primary.label + name + ' · 就绪';
      else if (r.focused) text = '已聚焦 ' + primary.label + name;
      else text = r.count + ' 个编辑器 · 插入时选择';
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

  S.busy = true;
  ui.insert.disabled = true;
  setChip('idle', '正在插入…');

  try {
    const r = await run({ op: 'insert', code, lastChoice: S.lastChoice });

    if (!r) {
      setChip('err', '页面无响应，请刷新后重试');
      return;
    }

    if (r.pending) {
      setChip('warn', '请在页面选择编辑器（' + r.count + ' 个）');
      return;
    }

    if (r.ok) {
      const tag = r.verified === 'strict' ? '' : r.verified === 'weak' ? ' · 弱校验' : ' · 未校验';
      setChip('ok', '✓ 已插入 ' + r.chars + ' 字符' + tag);
      await pushHistory(code);
    } else {
      setChip('err', mapReason(r.reason));
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
}

function mapReason(reason) {
  if (!reason) return '插入失败';
  if (reason === 'no-editor') return '没有找到可插入的编辑器';
  if (reason === 'empty') return '没有内容可插入';
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

/* ---------------- 历史 ---------------- */

async function pushHistory(code) {
  try {
    const { history = [] } = await chrome.storage.local.get('history');
    const next = [{ id: Date.now().toString(36), code, ts: Date.now() }]
      .concat(history.filter((h) => h.code !== code))
      .slice(0, 10);
    await chrome.storage.local.set({ history: next });
    S.history = next;
  } catch (_) {}
}

async function renderHistory() {
  let history = [];
  try {
    const r = await chrome.storage.local.get('history');
    history = Array.isArray(r.history) ? r.history : [];
  } catch (_) {}
  S.history = history;

  ui.list.textContent = '';

  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有插入记录。成功插入一次后，这里会保存最近 10 段代码。';
    ui.list.appendChild(li);
    return;
  }

  history.forEach((h) => {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';

    const prev = document.createElement('div');
    prev.className = 'item-preview';
    prev.textContent = firstLine(h.code);

    const sub = document.createElement('div');
    sub.className = 'item-sub';
    const lines = h.code.split('\n').length;
    sub.textContent = h.code.length + ' 字符 · ' + lines + ' 行 · ' + fmtTime(h.ts);

    main.appendChild(prev);
    main.appendChild(sub);

    const del = document.createElement('button');
    del.className = 'item-del';
    del.textContent = '×';
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = S.history.filter((x) => x.id !== h.id);
      S.history = next;
      try {
        await chrome.storage.local.set({ history: next });
      } catch (_) {}
      renderHistory();
    });

    li.appendChild(main);
    li.appendChild(del);
    li.addEventListener('click', () => {
      ui.code.value = h.code;
      updateCount();
      scheduleDraftSave();
      ui.panel.classList.add('hidden');
      ui.code.focus();
    });

    ui.list.appendChild(li);
  });
}

function firstLine(code) {
  const line = String(code).split('\n')[0].trim();
  return line.length > 46 ? line.slice(0, 46) + '…' : line || '（空行开头）';
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

/* ---------------- 站点记忆 ---------------- */

async function loadChoice() {
  try {
    const key = 'choice:' + S.origin;
    const o = await chrome.storage.local.get(key);
    return o[key] || null;
  } catch (_) {
    return null;
  }
}

async function saveChoice(choice) {
  try {
    const key = 'choice:' + S.origin;
    await chrome.storage.local.set({ [key]: choice });
  } catch (_) {}
}
