/* 贴进去 · PasteBridge — 门面
 *
 * 唯一暴露给 popup 的入口：window.__WB__.run(payload)
 * 所有返回值必须是 JSON 可序列化的，因为要穿过 executeScript 边界。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  if (!NS.core || !NS.detect || !NS.insert || !NS.picker) return;

  const core = NS.core;
  const detect = NS.detect;
  const insert = NS.insert;
  const picker = NS.picker;
  const V = '1.0.0';

  const F = (window.__WB__ = window.__WB__ || {});
  F.v = V;
  F.state =
    F.state ||
    { lastStatus: null, lastFocus: null, picked: null, tracking: false, installedAt: Date.now() };

  /* 记录最近聚焦过的编辑器，作为打分信号 */
  if (!F.state.tracking) {
    F.state.tracking = true;
    document.addEventListener(
      'focusin',
      (e) => {
        const t = e.target;
        if (!t || t.nodeType !== 1) return;
        const hit = core.closestDeep(
          t,
          '.cm-editor,.CodeMirror,.monaco-editor,.ace_editor,textarea,[contenteditable="true"],[role="textbox"]'
        );
        if (hit) F.state.lastFocus = t;
      },
      true
    );
  }

  function labelOf(kind) {
    const spec = detect.SPECS.find((s) => s.kind === kind);
    return spec ? spec.label : '编辑器';
  }

  function reasonText(reason) {
    const map = {
      'no-editor': '没有找到可插入的编辑器',
      empty: '没有内容可插入',
      'inject-failed': '注入失败，请刷新页面后重试'
    };
    if (map[reason]) return map[reason];
    if (!reason) return '未知原因';
    return String(reason);
  }

  function precheck() {
    const list = detect.detect();
    const best = detect.bestOf(list);
    return {
      ok: true,
      v: V,
      count: list.length,
      choices: list.map((c, i) => ({
        i,
        kind: c.kind,
        label: c.label,
        name: c.name,
        nth: c.nth,
        readonly: c.readonly,
        score: Math.round(c.score)
      })),
      primary: best ? list.indexOf(best) : null,
      focused: !!(best && best.focused),
      iframes: document.querySelectorAll('iframe').length,
      picked: F.state.picked,
      lastStatus: F.state.lastStatus
    };
  }

  /* 选目标：显式指定 > 当前聚焦 > 站点记忆 > 唯一候选 > 打分明显领先 > 点选 */
  function choose(list, payload) {
    if (typeof payload.choice === 'number' && list[payload.choice]) {
      return { target: list[payload.choice], mode: 'explicit' };
    }
    const writable = list.filter((c) => !c.readonly);
    const pool = writable.length ? writable : list;

    const focused = pool.filter((c) => c.focused).sort((a, b) => b.score - a.score)[0];
    if (focused) return { target: focused, mode: 'focus' };

    if (payload.lastChoice) {
      const m = pool.find(
        (c) => c.kind === payload.lastChoice.kind && c.nth === payload.lastChoice.nth
      );
      if (m) return { target: m, mode: 'memory' };
    }

    if (pool.length === 1) return { target: pool[0], mode: 'single' };

    const sorted = pool.slice().sort((a, b) => b.score - a.score);
    const gap = sorted.length > 1 ? sorted[0].score - sorted[1].score : 9999;
    if (sorted.length && gap > 150) return { target: sorted[0], mode: 'score' };

    return { target: null, mode: 'pick' };
  }

  function report(r) {
    F.state.lastStatus = {
      ok: !!r.ok,
      kind: r.kind || null,
      method: r.method || null,
      verified: r.verified || 'none',
      chars: r.chars || 0,
      reason: r.reason || null,
      ts: Date.now()
    };

    if (r.ok) {
      const tag =
        r.verified === 'strict' ? '' : r.verified === 'weak' ? ' · 弱校验' : ' · 未校验';
      core.toast('已插入 ' + r.chars + ' 字符 · ' + labelOf(r.kind) + tag, 'ok', 2200);
    } else {
      core.toast('插入失败：' + reasonText(r.reason), 'err', 3600);
    }
  }

  async function doInsert(payload) {
    const code = String(payload && payload.code != null ? payload.code : '');
    if (!code) {
      core.toast('没有内容可插入', 'err', 1800);
      return { ok: false, reason: 'empty' };
    }

    const list = detect.detect();
    if (!list.length) {
      const hasFrame = document.querySelectorAll('iframe').length > 0;
      core.toast(
        hasFrame ? '没有找到编辑器（它可能藏在 iframe 里）' : '没有找到可插入的编辑器',
        'err',
        3200
      );
      return { ok: false, reason: 'no-editor', iframes: hasFrame };
    }

    const picked = choose(list, payload);
    if (!picked.target) {
      const pool = list.filter((c) => !c.readonly);
      const shown = pool.length ? pool : list;
      picker.pick(
        shown,
        async (c) => {
          F.state.picked = { kind: c.kind, nth: c.nth };
          const r = await insert.insertInto(c, code);
          report(r);
        },
        () => core.toast('已取消', 'info', 1500)
      );
      return { ok: true, pending: true, count: shown.length };
    }

    const r = await insert.insertInto(picked.target, code);
    report(r);
    return r;
  }

  async function run(payload) {
    const op = payload && payload.op;
    try {
      if (op === 'precheck') return precheck();
      if (op === 'insert') return await doInsert(payload);
      if (op === 'cancel') {
        picker.cancel();
        return { ok: true };
      }
      return { ok: false, reason: 'unknown-op' };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e) };
    }
  }

  F.run = run;
  F.cancel = () => picker.cancel();
  F.reasonText = reasonText;
})();
