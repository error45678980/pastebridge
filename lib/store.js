/* 贴进去 · PasteBridge — 存储层
 *
 * 设计要点：
 * 1. 索引与正文分键存放。列表页只读索引，不把几十万字正文拖进内存。
 * 2. 索引里只放 120 字预览 + FNV-1a 指纹，靠指纹去重。
 * 3. chrome.storage.local 只有 10MB。写入后按估算体积淘汰最旧的非置顶项，
 *    整块重写数组会直接撞 QUOTA 上限，所以正文必须一条一个键。
 *
 * 三种运行环境共用：
 *   · background/sw.js  → importScripts('/lib/store.js')
 *   · popup / workbench → <script src="../lib/store.js">
 *   · Node 测试         → createRequire(import.meta.url)('../lib/store.js')
 */
(() => {
  'use strict';

  const SCHEMA = 2;
  const HIGH_WATER = 8 * 1024 * 1024; // 超过就淘汰
  const LOW_WATER = 6 * 1024 * 1024; // 淘汰到这个水位以下
  const MAX_SINGLE = 256 * 1024; // 单条超过 256KB 只留元数据
  const MAX_INDEX = 300;

  const DEFAULTS = {
    schemaVersion: SCHEMA,
    md: { on: false, lang: '' },
    historyLimit: 50,
    capture: { on: false, maxLen: 200000 },
    ui: { tab: 'insert' },
    /* 键盘模拟：on 只是用户意图，真正可用还要看 debugger 权限 */
    typing: { on: false, mode: 'auto', maxChars: 2000, autoFallback: false, tabAsSpaces: 2 }
  };

  const K = {
    settings: 'settings',
    draft: 'draft',
    clipIndex: 'clip:index',
    clipItem: (id) => 'clip:item/' + id,
    snipIndex: 'snip:index',
    snipItem: (id) => 'snip:item/' + id,
    inserts: 'inserts',
    site: (origin) => 'sites/' + origin
  };

  /* ---------------- 适配器（测试时可替换） ---------------- */

  const chromeAdapter = {
    async get(keys) {
      return chrome.storage.local.get(keys);
    },
    async set(obj) {
      return chrome.storage.local.set(obj);
    },
    async remove(keys) {
      return chrome.storage.local.remove(keys);
    },
    async bytes() {
      try {
        return await chrome.storage.local.getBytesInUse(null);
      } catch (_) {
        return 0;
      }
    }
  };

  let adapter = chromeAdapter;

  function use(a) {
    adapter = a || chromeAdapter;
    readyPromise = null;
  }

  /* ---------------- 小工具 ---------------- */

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function preview(text, n) {
    const line = String(text || '')
      .split('\n')[0]
      .trim();
    const s = line || '（空行开头）';
    return s.length > (n || 120) ? s.slice(0, n || 120) + '…' : s;
  }

  function guessKind(text) {
    const s = String(text || '').trim();
    if (/^https?:\/\/\S+$/i.test(s)) return 'link';
    if (s.indexOf('\n') >= 0 || /[{};<>]\s*$/m.test(s)) return 'code';
    return 'text';
  }

  function bytesOf(s) {
    // UTF-16 粗估：chrome.storage 按字符计
    return String(s || '').length * 2;
  }

  /* ---------------- 迁移 ---------------- */

  let readyPromise = null;

  async function migrate() {
    const all = (await adapter.get(null)) || {};
    const settings = mergeSettings(DEFAULTS, all[K.settings]);
    const patch = {};

    // v1 的 history[] → inserts[]
    if (!Array.isArray(all[K.inserts])) {
      const old = Array.isArray(all.history) ? all.history : [];
      patch[K.inserts] = old
        .slice(0, settings.historyLimit || 50)
        .map((h) => ({
          id: h.id || uid(),
          ts: h.ts || Date.now(),
          origin: '',
          kind: guessKind(h.code),
          method: '',
          verified: '',
          chars: String(h.code || '').length,
          preview: preview(h.code)
        }));
    }

    // v1 的 choice:<origin> → sites/<origin>
    for (const key of Object.keys(all)) {
      if (key.indexOf('choice:') !== 0) continue;
      const origin = key.slice('choice:'.length);
      const target = K.site(origin);
      if (all[target]) continue;
      const v = all[key];
      if (v && v.kind) patch[target] = { kind: v.kind, nth: v.nth || 1, frameKey: v.frameKey || null, ts: Date.now() };
    }

    if (!Array.isArray(all[K.clipIndex])) patch[K.clipIndex] = [];
    if (!Array.isArray(all[K.snipIndex])) patch[K.snipIndex] = [];

    settings.schemaVersion = SCHEMA;
    patch[K.settings] = settings;

    await adapter.set(patch);
    return settings;
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = migrate().catch((e) => {
        readyPromise = null;
        throw e;
      });
    }
    return readyPromise;
  }

  /* ---------------- 设置 ---------------- */

  /* 设置是分层的，浅合并会让「旧版本存下的 typing 对象」整体覆盖掉新默认值，
   * 于是新增字段永远拿不到默认值。所以统一走这里做深合并。 */
  function mergeSettings(base, cur) {
    const b = base || {};
    const c = cur || {};
    return Object.assign({}, b, c, {
      md: Object.assign({}, b.md, c.md),
      capture: Object.assign({}, b.capture, c.capture),
      ui: Object.assign({}, b.ui, c.ui),
      typing: Object.assign({}, b.typing, c.typing),
      schemaVersion: SCHEMA
    });
  }

  async function getSettings() {
    await ready();
    const r = await adapter.get(K.settings);
    return mergeSettings(DEFAULTS, r[K.settings]);
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = mergeSettings(cur, patch || {});
    await adapter.set({ [K.settings]: next });
    return next;
  }

  /* ---------------- 剪贴板历史 ---------------- */

  async function getClipIndex() {
    const r = await adapter.get(K.clipIndex);
    return Array.isArray(r[K.clipIndex]) ? r[K.clipIndex] : [];
  }

  async function putClip(entry) {
    await ready();
    const text = String((entry && entry.text) || '');
    if (!text.trim()) return null;

    const maxLen = (await getSettings()).capture.maxLen || 200000;
    const body = text.length > maxLen ? text.slice(0, maxLen) : text;
    const hash = fnv(body);
    const idx = await getClipIndex();
    const now = Date.now();

    const existing = idx.find((x) => x.hash === hash);
    if (existing) {
      existing.ts = now;
      existing.hits = (existing.hits || 1) + 1;
      if (entry && entry.pin) existing.pin = true;
      // 置顶项也要挪到最前
      const rest = idx.filter((x) => x !== existing);
      await adapter.set({ [K.clipIndex]: [existing].concat(rest) });
      return existing;
    }

    const id = uid();
    const meta = {
      id,
      ts: now,
      len: body.length,
      hash,
      pin: !!(entry && entry.pin),
      kind: (entry && entry.kind) || guessKind(body),
      preview: preview(body),
      src: (entry && entry.src) || null,
      hits: 1
    };

    const patch = { [K.clipIndex]: [meta].concat(idx).slice(0, MAX_INDEX) };
    // 超大内容只留元数据，避免一条就把配额吃光
    patch[K.clipItem(id)] = body.length > MAX_SINGLE ? body.slice(0, MAX_SINGLE) : body;

    await adapter.set(patch);
    await trimClips();
    return meta;
  }

  async function getClipText(id) {
    const r = await adapter.get(K.clipItem(id));
    return r[K.clipItem(id)] || '';
  }

  async function pinClip(id, on) {
    const idx = await getClipIndex();
    const it = idx.find((x) => x.id === id);
    if (!it) return false;
    it.pin = !!on;
    await adapter.set({ [K.clipIndex]: idx });
    return true;
  }

  async function removeClip(id) {
    const idx = await getClipIndex();
    const next = idx.filter((x) => x.id !== id);
    await adapter.remove(K.clipItem(id));
    await adapter.set({ [K.clipIndex]: next });
    return next;
  }

  async function clearClips(keepPinned) {
    const idx = await getClipIndex();
    const keep = keepPinned ? idx.filter((x) => x.pin) : [];
    const drop = idx.filter((x) => !keep.includes(x)).map((x) => K.clipItem(x.id));
    if (drop.length) await adapter.remove(drop);
    await adapter.set({ [K.clipIndex]: keep });
    return keep;
  }

  /* 数量 + 体积双重淘汰：置顶项永不淘汰 */
  async function trimClips() {
    const settings = await getSettings();
    const limit = Math.max(5, settings.historyLimit || 50);
    let idx = await getClipIndex();

    const over = idx.filter((x) => !x.pin).slice(limit);
    if (over.length) {
      await adapter.remove(over.map((x) => K.clipItem(x.id)));
      idx = idx.filter((x) => x.pin || !over.includes(x));
      await adapter.set({ [K.clipIndex]: idx });
    }

    let used = await adapter.bytes();
    if (used <= HIGH_WATER) return idx;

    const removable = idx.filter((x) => !x.pin).sort((a, b) => a.ts - b.ts);
    const drop = [];
    while (used > LOW_WATER && removable.length) {
      const it = removable.shift();
      drop.push(it);
      used -= bytesOf(it.preview) + (it.len || 0) * 2 + 200;
    }
    if (drop.length) {
      await adapter.remove(drop.map((x) => K.clipItem(x.id)));
      idx = idx.filter((x) => !drop.includes(x));
      await adapter.set({ [K.clipIndex]: idx });
    }
    return idx;
  }

  /* ---------------- 片段库 ---------------- */

  async function getSnipIndex() {
    const r = await adapter.get(K.snipIndex);
    return Array.isArray(r[K.snipIndex]) ? r[K.snipIndex] : [];
  }

  async function putSnippet(entry) {
    await ready();
    const body = String((entry && entry.text) || '');
    if (!body.trim()) return null;

    const idx = await getSnipIndex();
    const id = (entry && entry.id) || uid();
    const now = Date.now();
    const prev = idx.find((x) => x.id === id);

    const meta = {
      id,
      ts: prev ? prev.ts : now,
      used: prev ? prev.used || 0 : 0,
      updated: now,
      name: (entry && entry.name) || (prev && prev.name) || preview(body, 40),
      lang: (entry && entry.lang) || (prev && prev.lang) || '',
      tags: (entry && entry.tags) || (prev && prev.tags) || [],
      len: body.length,
      preview: preview(body)
    };

    const rest = idx.filter((x) => x.id !== id);
    await adapter.set({
      [K.snipIndex]: [meta].concat(rest),
      [K.snipItem(id)]: body
    });
    return meta;
  }

  async function getSnippetText(id) {
    const r = await adapter.get(K.snipItem(id));
    return r[K.snipItem(id)] || '';
  }

  async function useSnippet(id) {
    const idx = await getSnipIndex();
    const it = idx.find((x) => x.id === id);
    if (!it) return false;
    it.used = (it.used || 0) + 1;
    it.lastUsed = Date.now();
    await adapter.set({ [K.snipIndex]: idx });
    return true;
  }

  async function removeSnippet(id) {
    const idx = await getSnipIndex();
    const next = idx.filter((x) => x.id !== id);
    await adapter.remove(K.snipItem(id));
    await adapter.set({ [K.snipIndex]: next });
    return next;
  }

  /* ---------------- 插入记录 ---------------- */

  async function addInsert(rec) {
    await ready();
    const settings = await getSettings();
    const r = await adapter.get(K.inserts);
    const list = Array.isArray(r[K.inserts]) ? r[K.inserts] : [];
    const item = {
      id: uid(),
      ts: Date.now(),
      origin: rec.origin || '',
      kind: rec.kind || '',
      method: rec.method || '',
      verified: rec.verified || '',
      chars: rec.chars || 0,
      preview: preview(rec.text)
    };
    const next = [item].concat(list).slice(0, Math.max(10, settings.historyLimit || 50));
    await adapter.set({ [K.inserts]: next });
    return item;
  }

  async function listInserts() {
    await ready();
    const r = await adapter.get(K.inserts);
    return Array.isArray(r[K.inserts]) ? r[K.inserts] : [];
  }

  /* ---------------- 站点记忆 ---------------- */

  async function getSite(origin) {
    if (!origin) return null;
    const key = K.site(origin);
    const r = await adapter.get(key);
    return r[key] || null;
  }

  async function setSite(origin, choice) {
    if (!origin) return;
    await adapter.set({ [K.site(origin)]: Object.assign({}, choice, { ts: Date.now() }) });
  }

  /* ---------------- 导入 / 导出 ---------------- */

  async function exportAll() {
    await ready();
    const all = (await adapter.get(null)) || {};
    const clips = [];
    for (const meta of all[K.clipIndex] || []) {
      clips.push({ meta, text: all[K.clipItem(meta.id)] || '' });
    }
    const snips = [];
    for (const meta of all[K.snipIndex] || []) {
      snips.push({ meta, text: all[K.snipItem(meta.id)] || '' });
    }
    return { v: SCHEMA, ts: Date.now(), settings: all[K.settings] || DEFAULTS, clips, snips };
  }

  async function importAll(data) {
    if (!data || !data.v) throw new Error('不是有效的备份文件');
    const patch = {};
    const clipIdx = [];
    for (const c of data.clips || []) {
      const id = uid();
      clipIdx.push(Object.assign({}, c.meta, { id }));
      patch[K.clipItem(id)] = c.text || '';
    }
    const snipIdx = [];
    for (const s of data.snips || []) {
      const id = uid();
      snipIdx.push(Object.assign({}, s.meta, { id }));
      patch[K.snipItem(id)] = s.text || '';
    }
    patch[K.clipIndex] = clipIdx;
    patch[K.snipIndex] = snipIdx;
    if (data.settings) patch[K.settings] = Object.assign({}, DEFAULTS, data.settings, { schemaVersion: SCHEMA });
    await adapter.set(patch);
    return { clips: clipIdx.length, snips: snipIdx.length };
  }

  async function usage() {
    const used = await adapter.bytes();
    const idx = await getClipIndex();
    const snips = await getSnipIndex();
    return { bytes: used, clips: idx.length, snips: snips.length };
  }

  const PBStore = {
    SCHEMA,
    KEYS: K,
    DEFAULTS,
    use,
    ready,
    migrate,
    getSettings,
    saveSettings,
    putClip,
    getClipIndex,
    getClipText,
    pinClip,
    removeClip,
    clearClips,
    putSnippet,
    getSnipIndex,
    getSnippetText,
    useSnippet,
    removeSnippet,
    addInsert,
    listInserts,
    getSite,
    setSite,
    exportAll,
    importAll,
    usage,
    fnv,
    preview,
    guessKind
  };

  if (typeof globalThis !== 'undefined') globalThis.PBStore = PBStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = PBStore;
})();
