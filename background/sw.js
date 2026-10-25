'use strict';

/* 贴进去 · PasteBridge — 背景编排
 *
 * 为什么插入要由 SW 执行，而不是 popup 直接 executeScript：
 * 插入时页面会抢走焦点，弹窗随之关闭，popup 里那条 promise 会以
 * "message port closed" 结束，结果和错误全都拿不回来。
 * 交给 SW 后，弹窗关不关都不影响插入跑完；结果由页面自己的 toast 呈现，
 * 同时写进 storage.session 供下次打开弹窗时回显。
 *
 * 另外，iframe 多帧扫描也只能在这里做——只有 SW 能一次拿到所有 frameId。
 */

/* importScripts 的相对路径是相对 worker 脚本自身（background/）解析的，
 * 所以这里必须用扩展根目录的绝对路径，否则会去找 background/lib/files.js。 */
importScripts('/lib/files.js', '/lib/store.js', '/lib/typing.js', '/lib/cdp.js');

const PAGE_FILES = (self.PB_FILES && self.PB_FILES.page) || [];
const V = '2.1.1';

if (self.PBCdp) self.PBCdp.init();

/* tabId -> 'MAIN' | 'ISOLATED'，仅用于给弹窗显示「降级」状态 */
const worlds = new Map();

/* ---------------- 注入 ---------------- */

/**
 * 把页面脚本注入目标标签页。
 * 主世界优先——`el.CodeMirror`、`cmTile.view` 这类实例是页面脚本挂在 DOM 上的
 * 自定义属性，隔离世界读不到。少数站点拒绝主世界注入时降级到隔离世界：
 * 原生 API 通道失效，但 execCommand 仍然可用。
 */
async function inject(tabId, opts) {
  const allFrames = !!(opts && opts.allFrames);
  const world = (opts && opts.world) || 'MAIN';
  const target = allFrames ? { tabId, allFrames: true } : { tabId };

  try {
    const res = await chrome.scripting.executeScript({ target, files: PAGE_FILES, world });
    worlds.set(tabId, world);
    return { ok: true, world, frames: (res || []).map((r) => r.frameId) };
  } catch (e) {
    if (world === 'MAIN') return inject(tabId, { allFrames, world: 'ISOLATED' });
    return { ok: false, world, error: (e && e.message) || String(e) };
  }
}

/* ---------------- 执行 ---------------- */

async function exec(tabId, world, payload, frameIds) {
  const target = frameIds && frameIds.length ? { tabId, frameIds } : { tabId };
  const [res] = await chrome.scripting.executeScript({
    target,
    world,
    func: (p) => (window.__WB__ ? window.__WB__.run(p) : { ok: false, reason: 'inject-failed' }),
    args: [payload]
  });
  return res && res.result;
}

async function runOp(msg) {
  const tabId = msg.tabId;
  if (tabId == null) return { ok: false, reason: 'no-tab' };

  const payload = msg.payload || {};
  const op = payload.op || 'precheck';

  if (op === 'scan') return scanAll(tabId);

  /* 键盘模拟不走注入——它靠 CDP 直接往焦点里打字符 */
  if (op === 'type') {
    const r = await typeText(msg);
    if (r && r.ok) {
      try {
        await self.PBStore.addInsert({
          text: payload.code,
          kind: 'typed',
          method: r.method,
          verified: 'none',
          chars: r.chars,
          origin: ''
        });
      } catch (_) {}
      await notifyPage(
        tabId,
        '已键入 ' + r.chars + ' 字符' + (r.truncated ? '（超出上限，已截断）' : ''),
        'ok',
        msg.frameIds
      );
    } else if (r) {
      await notifyPage(tabId, '键入失败：' + (r.reason || '未知原因'), 'err', msg.frameIds);
    }
    return r;
  }

  const inj = await inject(tabId, {});
  if (!inj.ok) {
    return { ok: false, reason: 'inject-failed', detail: inj.error, world: inj.world };
  }

  const r = await exec(tabId, inj.world, payload, msg.frameIds);
  if (!r) return { ok: false, reason: 'no-response', world: inj.world };

  /* 插入成功就地落库。放在 SW 里而不是弹窗里，
   * 是因为弹窗随时可能被页面抢焦点关掉，那条链路会断。 */
  if (op === 'insert' && r.ok && r.chars) {
    try {
      await self.PBStore.addInsert({
        text: payload.code,
        kind: r.kind,
        method: r.method,
        verified: r.verified,
        chars: r.chars,
        origin: ''
      });
    } catch (_) {}
  }

  return Object.assign({ world: inj.world }, r);
}

/* ---------------- 键盘模拟 ---------------- */

async function typeText(msg) {
  const tabId = msg.tabId;
  if (!self.PBCdp || !self.PBType) return { ok: false, reason: 'cdp-unavailable' };

  const payload = msg.payload || {};
  const raw = String(payload.code == null ? '' : payload.code);
  if (!raw) return { ok: false, reason: 'empty' };

  let settings = {};
  try {
    settings = await self.PBStore.getSettings();
  } catch (_) {}
  const t = settings.typing || {};
  const mode = t.mode || 'auto';
  const maxChars = Math.max(200, t.maxChars || 2000);

  // 单行输入框装不下换行，压成空格（与插入通道保持一致）
  const text = payload.flat ? raw.replace(/\n/g, ' ') : raw;

  /* CDP 的 Input 只进「当前焦点」。跨帧键入时必须先在那一帧里 focus，
   * 否则字符会打到顶层文档里去。 */
  if (payload.choice) {
    try {
      const inj = await inject(tabId, {});
      if (inj.ok) {
        await exec(tabId, inj.world, { op: 'focus', choice: payload.choice }, msg.frameIds);
      }
    } catch (_) {}
  }

  const plan = self.PBType.planTyping(text, {
    mode: mode,
    maxChars: maxChars,
    tabAsSpaces: t.tabAsSpaces
  });

  const first = await self.PBCdp.typeOnce(tabId, plan.steps, {
    budgetMs: plan.mode === 'keys' ? 15000 : 6000
  });

  if (!first.ok) {
    return { ok: false, reason: first.reason, detail: first.detail, done: first.done };
  }

  /* 整段 insertText 没生效时，再逐字打一遍。
   * 只有拿得到目标时才敢判断——盲打两遍会把内容重复写进去。 */
  if (plan.fallback && plan.fallback.length && payload.choice) {
    let hasText = true;
    try {
      const inj = await inject(tabId, {});
      if (inj.ok) {
        const p = await exec(
          tabId,
          inj.world,
          { op: 'probe', choice: payload.choice },
          msg.frameIds
        );
        if (p && p.ok) hasText = String(p.text || '').indexOf(text) >= 0;
      }
    } catch (_) {}

    if (!hasText) {
      const second = await self.PBCdp.typeOnce(tabId, plan.fallback, { budgetMs: 15000 });
      if (second.ok) {
        return { ok: true, method: 'cdp-keys', chars: text.length, truncated: plan.meta.truncated };
      }
      return { ok: false, reason: second.reason, detail: second.detail, done: second.done };
    }
  }

  return {
    ok: true,
    method: 'cdp-' + plan.mode,
    chars: text.length,
    truncated: plan.meta.truncated
  };
}

/* 键入可能耗时几秒，弹窗未必还在。让页面自己弹一条结果提示。 */
async function notifyPage(tabId, text, kind, frameIds) {
  try {
    const inj = await inject(tabId, {});
    if (!inj.ok) return;
    await exec(tabId, inj.world, { op: 'toast', text: text, kind: kind }, frameIds);
  } catch (_) {}
}

/* ---------------- 跨 frame 扫描 ----------------
 *
 * activeTab 的授权覆盖不到所有子帧，所以走双通道：
 * 先试 allFrames 一次搞定，整体失败就退回只注顶层。
 * 每个帧各自扫描，结果在这里合并，并带上 frameId 供插入时定向。
 */
async function scanAll(tabId) {
  let inj = await inject(tabId, { allFrames: true });
  if (!inj.ok) inj = await inject(tabId, {});
  if (!inj.ok) {
    return { ok: false, reason: 'inject-failed', detail: inj.error, world: inj.world };
  }

  const ids = inj.frames && inj.frames.length ? inj.frames : [0];
  const frames = [];

  for (const fid of ids) {
    let r = null;
    try {
      r = await exec(tabId, inj.world, { op: 'scan' }, [fid]);
    } catch (_) {
      // 这个帧注不进去（跨域 / sandbox / 站点策略），跳过就好
    }
    if (r && r.ok) {
      frames.push({
        frameId: fid,
        isTop: !!r.isTop,
        href: r.href || '',
        count: r.count || 0,
        choices: r.choices || []
      });
    }
  }

  const choices = [];
  let num = 0;
  for (const f of frames) {
    for (const c of f.choices) {
      choices.push(
        Object.assign({}, c, { frameId: f.frameId, isTop: f.isTop, num: ++num })
      );
    }
  }

  return {
    ok: true,
    world: inj.world,
    count: choices.length,
    choices,
    frames: frames.map((f) => ({
      frameId: f.frameId,
      isTop: f.isTop,
      count: f.count,
      href: f.href
    }))
  };
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('pb:') !== 0) return false;

  (async () => {
    try {
      if (msg.type === 'pb:ping') {
        sendResponse({ ok: true, v: V, files: PAGE_FILES.length });
        return;
      }
      if (msg.type === 'pb:run') {
        sendResponse(await runOp(msg));
        return;
      }
      sendResponse({ ok: false, reason: 'unknown-message' });
    } catch (e) {
      sendResponse({ ok: false, reason: (e && e.message) || String(e) });
    }
  })();

  /* 返回 true 保持消息通道，异步 sendResponse 才有效 */
  return true;
});

/* ---------------- 生命周期 ---------------- */

chrome.runtime.onInstalled.addListener((d) => {
  // 迁移放在安装/升级时跑一次；各页面首次读取时还会再兜一次
  if (self.PBStore) self.PBStore.ready().catch(() => {});
  buildMenus();
  console.log('[贴进去] ' + V + ' 已就绪 · ' + d.reason);
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  worlds.delete(tabId);
});

/* 权限被撤销后，把「键盘模拟」开关一起关掉，
 * 否则用户每次点都只会收到一个看不懂的错误。 */
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(async (removed) => {
    const list = (removed && removed.permissions) || [];
    if (list.indexOf('debugger') < 0) return;
    try {
      await self.PBStore.saveSettings({ typing: { on: false } });
    } catch (_) {}
  });
}

/* ---------------- 右键菜单 ---------------- */

const MENUS = [
  { id: 'pb-save-selection', title: '保存选中文本到「贴进去」', contexts: ['selection'] },
  { id: 'pb-save-link', title: '保存此链接到「贴进去」', contexts: ['link'] },
  { id: 'pb-save-page', title: '保存本页标题与链接', contexts: ['page'] },
  { id: 'pb-insert-latest', title: '把最近一条内容插入这里', contexts: ['editable'] }
];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) {
      try {
        chrome.contextMenus.create(m);
      } catch (_) {}
    }
  });
}

/* ---------------- 采集与插入 ---------------- */

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

async function capture(text, src) {
  if (!text || !text.trim()) return false;
  try {
    await self.PBStore.putClip({ text, src: src || null });
    flashBadge('✓');
    return true;
  } catch (_) {
    return false;
  }
}

function flashBadge(text) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => {
      try {
        chrome.action.setBadgeText({ text: '' });
      } catch (_) {}
    }, 1600);
  } catch (_) {}
}

async function activeTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t || null;
  } catch (_) {
    return null;
  }
}

async function insertLatest(tabId) {
  const idx = await self.PBStore.getClipIndex();
  if (!idx.length) {
    flashBadge('∅');
    return { ok: false, reason: 'empty' };
  }
  const first = idx[0];
  const text = await self.PBStore.getClipText(first.id);
  if (!text) return { ok: false, reason: 'empty' };
  return runOp({ tabId, payload: { op: 'insert', code: text } });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab && tab.id != null ? tab.id : null;
  try {
    if (info.menuItemId === 'pb-save-selection') {
      await capture(info.selectionText || '', { title: tab && tab.title, url: tab && tab.url, host: hostOf(tab && tab.url) });
    } else if (info.menuItemId === 'pb-save-link') {
      const url = info.linkUrl || '';
      await capture(url, { title: info.linkText || url, url, host: hostOf(url) });
    } else if (info.menuItemId === 'pb-save-page') {
      if (!tab) return;
      await capture((tab.title || '') + '\n' + (tab.url || ''), {
        title: tab.title,
        url: tab.url,
        host: hostOf(tab.url)
      });
    } else if (info.menuItemId === 'pb-insert-latest') {
      if (tabId != null) await insertLatest(tabId);
    }
  } catch (_) {}
});

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    if (cmd === 'capture-selection') {
      const t = await activeTab();
      if (!t || t.id == null) return;
      const r = await runOp({ tabId: t.id, payload: { op: 'grab' } });
      if (r && r.ok && r.text) {
        await capture(r.text, { title: r.title, url: r.url, host: hostOf(r.url) });
      } else {
        flashBadge('∅');
      }
    } else if (cmd === 'insert-latest') {
      const t = await activeTab();
      if (t && t.id != null) await insertLatest(t.id);
    }
  } catch (_) {}
});
