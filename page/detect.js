/* 贴进去 · PasteBridge — 编辑器识别
 *
 * 识别顺序很重要：先容器、后通用控件。
 * 因为 Monaco / Ace / CodeMirror 内部都藏了一个 textarea 或 contenteditable，
 * 必须先命中容器，再靠「嵌套去重」把内部控件剔掉。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const core = NS.core;

  const SPECS = [
    { kind: 'cm6', sel: '.cm-editor', label: 'CodeMirror 6', dedicated: true },
    { kind: 'cm5', sel: '.CodeMirror', label: 'CodeMirror 5', dedicated: true },
    { kind: 'monaco', sel: '.monaco-editor', label: 'Monaco', dedicated: true },
    { kind: 'ace', sel: '.ace_editor', label: 'Ace', dedicated: true },
    { kind: 'textarea', sel: 'textarea', label: '文本框', dedicated: false },
    {
      kind: 'ce',
      sel: '[contenteditable="true"],[contenteditable=""],[role="textbox"]',
      label: '富文本',
      dedicated: false
    }
  ];

  function nameOf(node) {
    const attrs = ['aria-label', 'data-testid', 'data-mode-id', 'name', 'id'];
    for (const a of attrs) {
      let v;
      try {
        v = node.getAttribute(a);
      } catch (_) {}
      if (v && v.length <= 40) return v;
    }
    return '';
  }

  function isNested(node, collected) {
    for (const c of collected) {
      if (c.el !== node && c.el.contains(node)) return true;
    }
    return false;
  }

  function isReadonly(node, kind) {
    try {
      if (kind === 'cm5') {
        const cm = node.CodeMirror;
        if (cm && typeof cm.getOption === 'function') return !!cm.getOption('readOnly');
      }
      if (kind === 'ace') {
        const ed = node.env && node.env.editor;
        if (ed && typeof ed.getReadOnly === 'function') return !!ed.getReadOnly();
      }
      if (kind === 'monaco') {
        const ta = node.querySelector('textarea');
        if (ta && ta.readOnly) return true;
      }
      if (kind === 'textarea') return !!node.readOnly || !!node.disabled;
      if (kind === 'ce') {
        return (
          node.getAttribute('contenteditable') === 'false' ||
          node.getAttribute('aria-readonly') === 'true'
        );
      }
    } catch (_) {}
    return false;
  }

  function describe(node, spec, active) {
    if (!core.isVisible(node)) return null;
    let r;
    try {
      r = node.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    const focused = !!active && (node === active || node.contains(active));
    return {
      el: node,
      kind: spec.kind,
      label: spec.label,
      name: nameOf(node),
      dedicated: spec.dedicated,
      nth: 0,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      area: Math.max(0, r.width) * Math.max(0, r.height),
      focused,
      readonly: isReadonly(node, spec.kind),
      ariaHidden: node.getAttribute('aria-hidden') === 'true',
      score: 0
    };
  }

  function detect() {
    const roots = core.collectRoots();
    const active = core.activeElementDeep();
    const out = [];
    const counts = Object.create(null);

    for (const spec of SPECS) {
      for (const root of roots) {
        let nodes;
        try {
          nodes = root.querySelectorAll(spec.sel);
        } catch (_) {
          continue;
        }
        for (const node of nodes) {
          if (core.inOwnUI(node)) continue;
          if (isNested(node, out)) continue;
          const c = describe(node, spec, active);
          if (!c) continue;
          counts[spec.kind] = (counts[spec.kind] || 0) + 1;
          c.nth = counts[spec.kind];
          out.push(c);
        }
      }
    }

    scoreAll(out);
    return out;
  }

  function scoreAll(list) {
    const state = window.__WB__ && window.__WB__.state;
    const lastFocus = state && state.lastFocus;
    for (const c of list) {
      let s = c.area / 1000;
      if (c.dedicated) s += 50;
      if (c.focused) s += 1000;
      else if (lastFocus && lastFocus.isConnected) {
        try {
          if (c.el === lastFocus || c.el.contains(lastFocus)) s += 600;
        } catch (_) {}
      }
      if (c.ariaHidden) s -= 200;
      if (c.readonly) s -= 400;
      c.score = s;
    }
  }

  function bestOf(list) {
    const writable = list.filter((c) => !c.readonly);
    const pool = writable.length ? writable : list;
    let best = null;
    for (const c of pool) if (!best || c.score > best.score) best = c;
    return best;
  }

  NS.detect = { detect, bestOf, SPECS };
})();
