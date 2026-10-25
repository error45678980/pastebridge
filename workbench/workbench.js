/* 贴进去 · PasteBridge — 工作台
 *
 * 剪贴板历史 + 片段库 + 设置。
 * 约定：所有 DOM 都用 createElement / textContent 构建，不用 innerHTML，
 * 与扩展其余部分保持一致（也便于将来在严格 CSP 下复用）。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const S = {
  view: 'history',
  filter: 'all',
  q: '',
  clips: [],
  snips: [],
  texts: new Map(),
  settings: null,
  tabId: null,
  tabUrl: '',
  editing: null
};

/* ---------------- 小工具 ---------------- */

function el(tag, props, kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'title') n.title = props[k];
      else if (k.indexOf('data-') === 0) n.setAttribute(k, props[k]);
      else n[k] = props[k];
    }
  }
  for (const c of [].concat(kids || [])) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

let toastTimer = 0;
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = 'toast' + (kind ? ' ' + kind : '');
  }, 2400);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  const dt = new Date(ts);
  return dt.getMonth() + 1 + '月' + dt.getDate() + '日';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/* ---------------- 剪贴板写入 ---------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
    return true;
  } catch (_) {
    // 扩展页里 execCommand 通常不需要额外权限，作为兜底
    const ta = el('textarea', { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err');
    return ok;
  }
}

async function resolveTab() {
  if (S.tabId != null) {
    try {
      const t = await chrome.tabs.get(S.tabId);
      if (t && t.id != null) return t;
    } catch (_) {}
  }
  return null;
}

async function insertToPage(text) {
  const tab = await resolveTab();
  if (!tab) {
    toast('找不到目标页面，请从扩展弹窗点「工作台」进入', 'err');
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'pb:run',
      tabId: tab.id,
      payload: { op: 'insert', code: text }
    });
    if (r && r.ok) toast('已插入 ' + r.chars + ' 字符', 'ok');
    else if (r && r.pending) toast('请在页面里点选目标编辑器', 'err');
    else toast('插入失败：' + ((r && r.reason) || '未知'), 'err');
  } catch (e) {
    toast('插入失败：' + ((e && e.message) || e), 'err');
  }
}

/* ---------------- 权限 ---------------- */

async function hasClipboardPerm() {
  try {
    return await chrome.permissions.contains({ permissions: ['clipboardRead'] });
  } catch (_) {
    return false;
  }
}

async function hasHostPerm() {
  try {
    return await chrome.permissions.contains({ origins: ['*://*/*'] });
  } catch (_) {
    return false;
  }
}

async function hasDebuggerPerm() {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch (_) {
    return false;
  }
}

/* 必须在点击的同一个任务里调用，不能先 await 别的东西 */
function requestClipboardPerm() {
  chrome.permissions
    .request({ permissions: ['clipboardRead', 'clipboardWrite'] })
    .then((granted) => {
      toast(granted ? '已授权，可以读取剪贴板了' : '未授权', granted ? 'ok' : 'err');
      renderSettings();
    })
    .catch((e) => toast('授权失败：' + ((e && e.message) || e), 'err'));
}

function requestHostPerm() {
  chrome.permissions
    .request({ origins: ['*://*/*'] })
    .then((granted) => {
      toast(granted ? '已开启增强模式' : '未授权', granted ? 'ok' : 'err');
      renderSettings();
    })
    .catch((e) => toast('授权失败：' + ((e && e.message) || e), 'err'));
}

/* Chrome **不允许 debugger 作为可选权限**：写进 optional_permissions 会被静默丢弃，
 * 运行时 chrome.permissions.request 必定抛 "Only permissions specified in the manifest
 * may be requested"。所以它只能来自「增强版」安装包里的必需权限。 */
function debuggerDeclared() {
  try {
    return (chrome.runtime.getManifest().permissions || []).indexOf('debugger') >= 0;
  } catch (_) {
    return false;
  }
}

async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      toast('剪贴板是空的', 'err');
      return;
    }
    await PBStore.putClip({ text, src: { host: 'clipboard', title: '系统剪贴板' } });
    await refresh();
    toast('已收进历史', 'ok');
  } catch (e) {
    toast('读取失败：需要先授权剪贴板权限（设置里可开）', 'err');
  }
}

async function grabSelection() {
  const tab = await resolveTab();
  if (!tab) {
    toast('找不到目标页面，请从扩展弹窗点「工作台」进入', 'err');
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'pb:run',
      tabId: tab.id,
      payload: { op: 'grab' }
    });
    if (!r || !r.ok || !r.text) {
      toast('页面上没有选中文本', 'err');
      return;
    }
    await PBStore.putClip({
      text: r.text,
      src: { title: r.title, url: r.url, host: hostOf(r.url) }
    });
    await refresh();
    toast('已抓取选区（' + r.text.length + ' 字符）', 'ok');
  } catch (e) {
    toast('抓取失败：' + ((e && e.message) || e), 'err');
  }
}

/* ---------------- 渲染：历史 ---------------- */

function clipKindLabel(kind) {
  return kind === 'code' ? '代码' : kind === 'link' ? '链接' : '文本';
}

function matches(clip, text) {
  if (S.filter === 'pin' && !clip.pin) return false;
  if (S.filter === 'code' && clip.kind !== 'code') return false;
  if (S.filter === 'link' && clip.kind !== 'link') return false;
  if (S.filter === 'site') {
    if (!clip.src || !clip.src.url || !S.tabUrl) return false;
    if (hostOf(clip.src.url) !== hostOf(S.tabUrl)) return false;
  }
  if (S.q) {
    const q = S.q.toLowerCase();
    const hay = (clip.preview + '\n' + (text || '')).toLowerCase();
    if (hay.indexOf(q) < 0) return false;
  }
  return true;
}

async function renderHistory() {
  const list = $('#list');
  list.textContent = '';
  $('#filters').classList.remove('hidden');
  $('#settingsView').classList.add('hidden');

  const items = [];
  for (const c of S.clips) {
    let text = S.texts.get(c.id);
    if (text == null && (S.q || c.len < 4000)) {
      text = await PBStore.getClipText(c.id);
      S.texts.set(c.id, text);
    }
    if (matches(c, text)) items.push({ meta: c, text });
  }

  $('#empty').classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    $('#empty').textContent = S.q
      ? '没有匹配的内容'
      : S.filter !== 'all'
        ? '这个筛选下还没有内容'
        : '还没有记录。\n在任意页面复制内容后点「读取剪贴板」，或用 Alt+Shift+S 抓取选中文本。';
    return;
  }

  for (const it of items) {
    const c = it.meta;
    const card = el('li', { class: 'card' + (c.pin ? ' pin' : '') });

    const hd = el('div', { class: 'card-hd' }, [
      el('span', { class: 'tag ' + c.kind, text: clipKindLabel(c.kind) }),
      c.pin ? el('span', { class: 'tag', text: '置顶' }) : null,
      el('span', { class: 'meta', text: c.len + ' 字符 · ' + fmtTime(c.ts) })
    ]);

    const body = el('pre', { class: 'body', text: c.preview });
    if (it.text != null && c.len > c.preview.length) body.textContent = it.text;

    const acts = el('div', { class: 'acts-row' }, [
      el('button', { class: 'mini', text: '复制', onclick: () => copyText(it.text != null ? it.text : c.preview) }),
      el('button', {
        class: 'mini',
        text: '插入页面',
        onclick: async () => {
          const t = it.text != null ? it.text : await PBStore.getClipText(c.id);
          insertToPage(t);
        }
      }),
      el('button', {
        class: 'mini' + (c.pin ? ' on' : ''),
        text: c.pin ? '取消置顶' : '置顶',
        onclick: async () => {
          await PBStore.pinClip(c.id, !c.pin);
          await refresh();
        }
      }),
      el('button', {
        class: 'mini',
        text: '存为片段',
        onclick: () => openEditor({ text: it.text != null ? it.text : c.preview })
      }),
      el('button', {
        class: 'mini danger',
        text: '删除',
        onclick: async () => {
          await PBStore.removeClip(c.id);
          S.texts.delete(c.id);
          await refresh();
        }
      })
    ]);

    card.appendChild(hd);
    card.appendChild(body);
    if (c.src && (c.src.title || c.src.url)) {
      card.appendChild(
        el('div', {
          class: 'src',
          title: c.src.url || '',
          text: (c.src.title || c.src.url || '') + (c.src.url ? ' · ' + hostOf(c.src.url) : '')
        })
      );
    }
    card.appendChild(acts);

    // 点正文展开 / 收起
    body.addEventListener('click', async () => {
      if (!card.classList.contains('open') && it.text == null) {
        it.text = await PBStore.getClipText(c.id);
        S.texts.set(c.id, it.text);
        body.textContent = it.text;
      }
      card.classList.toggle('open');
    });

    list.appendChild(card);
  }
}

/* ---------------- 渲染：片段 ---------------- */

async function renderSnippets() {
  const list = $('#list');
  list.textContent = '';
  $('#filters').classList.add('hidden');
  $('#settingsView').classList.add('hidden');

  const q = S.q.toLowerCase();
  const items = S.snips.filter((s) => {
    if (!q) return true;
    return (
      (s.name + ' ' + s.preview + ' ' + (s.tags || []).join(' ') + ' ' + (s.lang || ''))
        .toLowerCase()
        .indexOf(q) >= 0
    );
  });

  $('#empty').classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    $('#empty').textContent = q
      ? '没有匹配的片段'
      : '还没有片段。\n点右下角「新建片段」，把常用的代码块、提示词、话术存起来。';
    list.appendChild(
      el('li', { class: 'card' }, [
        el('button', { class: 'btn primary', text: '＋ 新建片段', onclick: () => openEditor(null) })
      ])
    );
    return;
  }

  for (const s of items) {
    const card = el('li', { class: 'card' });
    const hd = el('div', { class: 'card-hd' }, [
      el('span', { class: 'tag', text: s.name || '未命名片段' }),
      s.lang ? el('span', { class: 'tag code', text: s.lang }) : null,
      el('span', { class: 'meta', text: (s.used || 0) + ' 次使用 · ' + s.len + ' 字符' })
    ]);
    const body = el('pre', { class: 'body', text: s.preview });

    const acts = el('div', { class: 'acts-row' }, [
      el('button', {
        class: 'mini',
        text: '复制',
        onclick: async () => {
          const t = await PBStore.getSnippetText(s.id);
          if (await copyText(t)) await PBStore.useSnippet(s.id);
        }
      }),
      el('button', {
        class: 'mini',
        text: '插入页面',
        onclick: async () => {
          const t = await PBStore.getSnippetText(s.id);
          await insertToPage(t);
          await PBStore.useSnippet(s.id);
        }
      }),
      el('button', {
        class: 'mini',
        text: '编辑',
        onclick: async () => {
          const t = await PBStore.getSnippetText(s.id);
          openEditor({ id: s.id, name: s.name, lang: s.lang, tags: (s.tags || []).join(','), text: t });
        }
      }),
      el('button', {
        class: 'mini danger',
        text: '删除',
        onclick: async () => {
          await PBStore.removeSnippet(s.id);
          await refresh();
        }
      })
    ]);

    card.appendChild(hd);
    card.appendChild(body);
    if ((s.tags || []).length) {
      card.appendChild(el('div', { class: 'src', text: s.tags.map((t) => '#' + t).join('  ') }));
    }
    card.appendChild(acts);
    list.appendChild(card);
  }
}

/* ---------------- 渲染：设置 ---------------- */

function switchRow(label, desc, on, onChange) {
  const sw = el('button', { class: 'switch' + (on ? ' on' : '') });
  sw.addEventListener('click', () => onChange(!on));
  return el('div', { class: 'row' }, [
    el('div', { class: 'lbl' }, [el('span', { text: label }), el('small', { text: desc })]),
    sw
  ]);
}

function numberRow(label, desc, value, min, max, onChange) {
  const input = el('input', { type: 'number', value: String(value), min: String(min), max: String(max) });
  input.addEventListener('change', () => onChange(Number(input.value) || min));
  return el('div', { class: 'row' }, [
    el('div', { class: 'lbl' }, [el('span', { text: label }), el('small', { text: desc })]),
    input
  ]);
}

function selectRow(label, desc, value, options, onChange) {
  const sel = el('select', {});
  for (const o of options) {
    const opt = el('option', { value: o.value, text: o.label });
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return el('div', { class: 'row' }, [
    el('div', { class: 'lbl' }, [el('span', { text: label }), el('small', { text: desc })]),
    sel
  ]);
}

async function renderSettings() {
  $('#filters').classList.add('hidden');
  $('#list').textContent = '';
  $('#empty').classList.add('hidden');

  const view = $('#settingsView');
  view.textContent = '';
  view.classList.remove('hidden');

  const st = await PBStore.getSettings();
  S.settings = st;
  const perm = await hasClipboardPerm();
  const hostPerm = await hasHostPerm();
  const dbgPerm = await hasDebuggerPerm();
  const u = await PBStore.usage();

  /* 插入偏好 */
  const card1 = el('div', { class: 'set-card' }, [
    el('h3', { text: '插入偏好' }),
    switchRow('包成 Markdown 代码块', '插到聊天框 / 富文本框时，自动加上 ``` 围栏', st.md.on, async (v) => {
      await PBStore.saveSettings({ md: { on: v } });
      renderSettings();
    }),
    numberRow('历史上限', '普通记录最多保留多少条（置顶不受限）', st.historyLimit, 5, 300, async (v) => {
      await PBStore.saveSettings({ historyLimit: v });
      toast('已保存', 'ok');
    }),
    numberRow('单条最大长度', '超过这个长度会被截断，避免吃满配额', st.capture.maxLen, 1000, 500000, async (v) => {
      await PBStore.saveSettings({ capture: { maxLen: v } });
      toast('已保存', 'ok');
    })
  ]);

  /* 键盘模拟 */
  const typing = st.typing || {};
  const typingKids = [el('h3', { text: '键盘模拟输入（最后手段）' })];

  if (dbgPerm) {
    typingKids.push(
      el('div', { class: 'row' }, [
        el('div', { class: 'lbl' }, [
          el('span', { text: '已内置调试权限' }),
          el('small', {
            text: '插入失败时可以把文字像人一样打进去（含终端、画布类编辑器）'
          })
        ]),
        el('span', { class: 'tag', text: '可用' })
      ]),
      switchRow(
        '插入失败时自动改用',
        '不用手动点按钮；逐字模式较慢，长文本慎用',
        !!typing.autoFallback,
        async (v) => {
          await PBStore.saveSettings({ typing: { autoFallback: v } });
          renderSettings();
        }
      ),
      selectRow(
        '键入方式',
        '自动 = 先整段写入，无效再逐字',
        typing.mode || 'auto',
        [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'insert', label: '只整段写入' },
          { value: 'keys', label: '只逐字模拟' }
        ],
        async (v) => {
          await PBStore.saveSettings({ typing: { mode: v } });
          toast('已保存', 'ok');
        }
      ),
      numberRow(
        '逐字上限',
        '超过这个长度会截断——逐字很慢',
        typing.maxChars || 2000,
        200,
        2000,
        async (v) => {
          await PBStore.saveSettings({ typing: { maxChars: v } });
          toast('已保存', 'ok');
        }
      ),
      el('div', { class: 'row' }, [
        el('div', { class: 'lbl' }, [
          el('span', { text: '使用须知' }),
          el('small', {
            text: '只在需要时附加调试器、用完立即断开；目标标签页开着开发者工具时会失败。'
          })
        ])
      ])
    );
  } else {
    typingKids.push(
      el('div', { class: 'row' }, [
        el('div', { class: 'lbl' }, [
          el('span', { text: '当前安装包不含键盘模拟' }),
          el('small', {
            text:
              'Chrome 不允许把调试权限（debugger）作为可选权限，所以它只能内置在「增强版」安装包里。' +
              '标准版仍可用盲插处理检测不到的编辑器。'
          })
        ]),
        el('span', { class: 'tag', text: '不可用' })
      ]),
      el('div', { class: 'row' }, [
        el('div', { class: 'lbl' }, [
          el('span', { text: '怎么启用' }),
          el('small', {
            text: '在项目里执行 python store/build-package.py --with-debugger，用生成的增强版包重新加载扩展。'
          })
        ])
      ])
    );
  }

  const typingCard = el('div', { class: 'set-card' }, typingKids);

  /* 剪贴板权限 */
  const permCard = el('div', { class: 'set-card' }, [
    el('h3', { text: '剪贴板权限' }),
    el('div', { class: 'row' }, [
      el('div', { class: 'lbl' }, [
        el('span', { text: perm ? '已授权读取剪贴板' : '未授权' }),
        el('small', {
          text: perm
            ? '可以用「读取剪贴板」把系统剪贴板内容收进历史'
            : '安装时零权限；只有你需要读取剪贴板时才申请'
        })
      ]),
      perm
        ? el('span', { class: 'tag', text: '已开启' })
        : el('button', { class: 'btn', text: '申请权限', onclick: () => requestClipboardPerm() })
    ]),
    el('div', { class: 'row' }, [
      el('div', { class: 'lbl' }, [
        el('span', { text: hostPerm ? '增强模式已开启' : '增强模式（跨域 iframe）' }),
        el('small', {
          text: hostPerm
            ? '可以扫描并插入跨域子帧里的编辑器'
            : '默认只覆盖顶层与同源子帧；开启后可访问跨域 iframe'
        })
      ]),
      hostPerm
        ? el('span', { class: 'tag', text: '已开启' })
        : el('button', { class: 'btn', text: '开启', onclick: () => requestHostPerm() })
    ])
  ]);

  /* 数据 */
  const dataCard = el('div', { class: 'set-card' }, [
    el('h3', { text: '数据' }),
    el('div', { class: 'row' }, [
      el('div', { class: 'lbl' }, [
        el('span', { text: '本地用量' }),
        el('small', { text: `${u.clips} 条历史 · ${u.snips} 个片段 · ${fmtBytes(u.bytes)}` })
      ])
    ]),
    el('div', { class: 'set-actions' }, [
      el('button', { class: 'btn', text: '导出 JSON', onclick: exportJson }),
      el('button', { class: 'btn', text: '导入 JSON', onclick: () => $('#importFile').click() }),
      el('button', {
        class: 'btn',
        text: '清空历史（保留置顶）',
        onclick: async () => {
          await PBStore.clearClips(true);
          await refresh();
          toast('已清空', 'ok');
        }
      })
    ])
  ]);

  view.appendChild(card1);
  view.appendChild(typingCard);
  view.appendChild(permCard);
  view.appendChild(dataCard);
}

/* ---------------- 导入导出 ---------------- */

async function exportJson() {
  const dump = await PBStore.exportAll();
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'pastebridge-backup-' + Date.now() + '.json' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已导出', 'ok');
}

async function importJson(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const r = await PBStore.importAll(data);
    await refresh();
    toast('已导入 ' + r.clips + ' 条历史 / ' + r.snips + ' 个片段', 'ok');
  } catch (e) {
    toast('导入失败：' + ((e && e.message) || e), 'err');
  }
}

/* ---------------- 片段编辑器 ---------------- */

function openEditor(data) {
  S.editing = data || {};
  $('#edTitle').textContent = data && data.id ? '编辑片段' : '新建片段';
  $('#edName').value = (data && data.name) || '';
  $('#edLang').value = (data && data.lang) || '';
  $('#edTags').value = (data && data.tags) || '';
  $('#edBody').value = (data && data.text) || '';
  $('#edHint').textContent = '';
  $('#editor').classList.remove('hidden');
  $('#edName').focus();
}

function closeEditor() {
  $('#editor').classList.add('hidden');
  S.editing = null;
}

async function saveEditor() {
  const body = $('#edBody').value;
  if (!body.trim()) {
    $('#edHint').textContent = '内容不能为空';
    return;
  }
  await PBStore.putSnippet({
    id: S.editing && S.editing.id,
    name: $('#edName').value.trim() || undefined,
    lang: $('#edLang').value.trim(),
    tags: $('#edTags')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    text: body
  });
  closeEditor();
  await refresh();
  toast('片段已保存', 'ok');
}

/* ---------------- 渲染调度 ---------------- */

async function refresh() {
  S.clips = await PBStore.getClipIndex();
  S.snips = await PBStore.getSnipIndex();
  $('#cHistory').textContent = String(S.clips.length);
  $('#cSnip').textContent = String(S.snips.length);

  const u = await PBStore.usage();
  $('#usage').textContent = fmtBytes(u.bytes) + ' / 10 MB';

  if (S.view === 'settings') await renderSettings();
  else if (S.view === 'snippets') await renderSnippets();
  else await renderHistory();
}

/* ---------------- 事件 ---------------- */

function bind() {
  document.querySelectorAll('.nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b === btn));
      S.view = btn.dataset.view;
      S.q = '';
      $('#q').value = '';
      refresh();
    });
  });

  document.querySelectorAll('.chip[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-filter]').forEach((b) => b.classList.toggle('on', b === btn));
      S.filter = btn.dataset.filter;
      renderHistory();
    });
  });

  let qTimer = 0;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    const v = e.target.value.trim();
    qTimer = setTimeout(() => {
      S.q = v;
      refresh();
    }, 180);
  });

  $('#readClip').addEventListener('click', () => readClipboard());
  $('#grabSel').addEventListener('click', () => grabSelection());

  $('#clearAll').addEventListener('click', async () => {
    if (!confirm('清空全部历史？置顶项会保留。')) return;
    await PBStore.clearClips(true);
    await refresh();
    toast('已清空', 'ok');
  });

  $('#edClose').addEventListener('click', closeEditor);
  $('#edSave').addEventListener('click', saveEditor);
  $('#editor').addEventListener('click', (e) => {
    if (e.target === $('#editor')) closeEditor();
  });

  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await importJson(f);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#editor').classList.contains('hidden')) closeEditor();
    if (e.key === '/' && document.activeElement !== $('#q')) {
      e.preventDefault();
      $('#q').focus();
    }
  });
}

/* ---------------- 启动 ---------------- */

(async () => {
  // 隐藏的文件选择器
  const picker = el('input', { type: 'file', id: 'importFile', accept: '.json,application/json' });
  picker.style.display = 'none';
  document.body.appendChild(picker);

  await PBStore.ready();
  S.settings = await PBStore.getSettings();

  try {
    const sess = await chrome.storage.session.get(['lastTabId', 'lastUrl']);
    S.tabId = sess.lastTabId != null ? sess.lastTabId : null;
    S.tabUrl = sess.lastUrl || '';
  } catch (_) {}

  if (S.tabUrl) {
    $('#tabInfo').textContent = '插入目标：' + hostOf(S.tabUrl);
  } else {
    $('#tabInfo').textContent = '插入目标：未指定（请从弹窗进入）';
  }

  bind();

  // 弹窗里点「授权键盘模拟」会带着 #settings 打开工作台，直接落到设置页
  if (location.hash === '#settings') {
    S.view = 'settings';
    document.querySelectorAll('.nav').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === 'settings');
    });
  }

  await refresh();
})();
