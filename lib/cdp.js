/* 贴进去 · PasteBridge — CDP 传输层
 *
 * 只有 background service worker 能用：chrome.debugger 是 SW 专属 API。
 *
 * 设计约束：
 * 1. 附加调试器会让浏览器顶部出现一条黄色提示条，所以**用完必须立刻断开**。
 * 2. 同一标签页的两次键入要排队，不能并发 attach。
 * 3. 用户在提示条上点「取消」会触发 onDetach，此时必须立刻停止后续命令，
 *    否则会把剩下半截文本打进别的元素里。
 */
(() => {
  'use strict';

  const VERSION = '1.3';
  const sessions = new Map(); // tabId -> {at, aborted}
  const queues = new Map(); // tabId -> Promise

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 同一 tab 串行：第二次点击排队，而不是并发 attach */
  function withLock(tabId, fn) {
    const prev = queues.get(tabId) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(
      tabId,
      next.catch(() => {})
    );
    return next;
  }

  async function attach(tabId) {
    if (sessions.has(tabId)) return { ok: true, reused: true };

    try {
      await chrome.debugger.attach({ tabId: tabId }, VERSION);
      sessions.set(tabId, { at: Date.now(), aborted: false });
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already attached/i.test(msg)) {
        // 可能是自己上次没断干净：先断开再试一次。
        // 如果占用者是真 DevTools / Playwright，这次仍会失败。
        try {
          await chrome.debugger.detach({ tabId: tabId });
        } catch (_) {}
        try {
          await chrome.debugger.attach({ tabId: tabId }, VERSION);
          sessions.set(tabId, { at: Date.now(), aborted: false });
          return { ok: true, retried: true };
        } catch (e2) {
          return {
            ok: false,
            reason: 'debugger-busy',
            detail: String((e2 && e2.message) || e2)
          };
        }
      }
      if (/cannot attach|cannot access|chrome:\/\/|devtools/i.test(msg)) {
        return { ok: false, reason: 'debugger-denied', detail: msg };
      }
      return { ok: false, reason: 'debugger-busy', detail: msg };
    }
  }

  async function detach(tabId, delayMs) {
    const s = sessions.get(tabId);
    if (!s) return;
    sessions.delete(tabId);
    if (delayMs) await sleep(delayMs);
    try {
      await chrome.debugger.detach({ tabId: tabId });
    } catch (_) {
      /* tab 已关闭 / 已被系统断开，忽略 */
    }
  }

  async function send(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
  }

  async function runSteps(tabId, steps, opts) {
    const o = opts || {};
    const gapMs = o.gapMs == null ? 0 : o.gapMs;
    const budgetMs = o.budgetMs || 15000;
    const t0 = Date.now();
    let done = 0;

    for (const step of steps) {
      const s = sessions.get(tabId);
      if (!s || s.aborted) return { ok: false, reason: 'debugger-detached', done: done };
      if (Date.now() - t0 > budgetMs) return { ok: false, reason: 'timeout', done: done };

      try {
        await send(tabId, step.method, step.params);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/detached|not attached|target closed|no tab/i.test(msg)) {
          return { ok: false, reason: 'debugger-detached', done: done, detail: msg };
        }
        return { ok: false, reason: 'cdp-failed', done: done, detail: msg };
      }

      done++;
      if (step.waitMs) await sleep(step.waitMs);
      else if (gapMs) await sleep(gapMs);
    }

    return { ok: true, done: done };
  }

  /* 一次完整的「附加 → 执行 → 断开」 */
  async function typeOnce(tabId, steps, opts) {
    if (!steps || !steps.length) return { ok: true, done: 0, empty: true };

    return withLock(tabId, async () => {
      const a = await attach(tabId);
      if (!a.ok) return { ok: false, reason: a.reason, detail: a.detail, done: 0 };

      let r;
      try {
        r = await runSteps(tabId, steps, opts);
      } finally {
        // 延迟一点点再断，让最后一批输入事件落地；
        // 太早 detach 会吞掉尾巴，太晚提示条会一直挂着。
        await detach(tabId, 180);
      }
      return r;
    });
  }

  function isAttached(tabId) {
    return sessions.has(tabId);
  }

  function init() {
    chrome.debugger.onDetach.addListener((source) => {
      const tabId = source && source.tabId;
      if (tabId == null) return;
      const s = sessions.get(tabId);
      if (s) s.aborted = true;
      sessions.delete(tabId);
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      sessions.delete(tabId);
      queues.delete(tabId);
    });
  }

  const PBCdp = { init, attach, detach, send, runSteps, typeOnce, withLock, isAttached, VERSION };

  if (typeof globalThis !== 'undefined') globalThis.PBCdp = PBCdp;
  if (typeof module !== 'undefined' && module.exports) module.exports = PBCdp;
})();
