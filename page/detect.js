/* 贴进去 · PasteBridge — 编辑器识别
 *
 * 识别顺序很重要：先容器、后通用控件。
 * 因为 Monaco / Ace / CodeMirror 内部都藏了一个 textarea 或 contenteditable，
 * 而富文本编辑器本身又带着 contenteditable 属性，会被通用规则二次命中。
 *
 * 所以去重必须双向：
 *   · 已收录元素的**后代** → 跳过（Monaco 里的 textarea）
 *   · 已收录元素的**祖先** → 跳过（包着 ProseMirror 的 contenteditable 外壳）
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const core = NS.core;
  const specs = NS.specs;
  const SPECS = specs.SPECS;

  function nameOf(node) {
    const attrs = ['aria-label', 'data-testid', 'data-mode-id', 'name', 'id', 'placeholder'];
    for (const a of attrs) {
      let v;
      try {
        v = node.getAttribute(a);
      } catch (_) {}
      if (v && v.length <= 40) return v;
    }
    return '';
  }

  /** 与已收录候选存在包含关系（任一方向）就跳过 */
  function overlaps(node, collected) {
    for (const c of collected) {
      if (c.el === node) return true;
      try {
        if (c.el.contains(node)) return true;
        if (node.contains(c.el)) return true;
      } catch (_) {}
    }
    return false;
  }

  const SPECS_BY_CAT = { rich: new Set() };
  for (const s of SPECS) if (s.cat === 'rich') SPECS_BY_CAT.rich.add(s.kind);

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
      if (kind === 'textarea' || kind === 'input') return !!node.readOnly || !!node.disabled;
      if (kind === 'ce' || SPECS_BY_CAT.rich.has(kind)) {
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
    const focused = !!active && (active === node || node.contains(active));
    return {
      el: node,
      kind: spec.kind,
      label: spec.label,
      cat: spec.cat,
      name: nameOf(node),
      dedicated: spec.cat !== 'plain',
      nth: 0,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      area: Math.max(0, r.width) * Math.max(0, r.height),
      focused,
      readonly: isReadonly(node, spec.kind),
      ariaHidden: node.getAttribute('aria-hidden') === 'true',
      score: 0
    };
  }

  function detect(opts) {
    const includeLow = !!(opts && opts.includeLowPriority);
    const roots = core.collectRoots();
    const active = core.activeElementDeep();
    const out = [];

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
          if (overlaps(node, out)) continue;
          const c = describe(node, spec, active);
          if (!c) continue;
          out.push(c);
        }
      }
    }

    // 单行输入框遍地都是（站点搜索框、筛选框），
    // 只在「已聚焦」或「页面上没有别的候选」时才让它参与选择。
    // 但显式指定目标时必须保留——否则用户选完、焦点一变它就消失了。
    const hasOther = out.some((c) => !specs.isLowPriority(c.kind));
    const kept =
      hasOther && !includeLow ? out.filter((c) => c.focused || !specs.isLowPriority(c.kind)) : out;

    // nth 必须在过滤后重新编号，否则按网站记住的选择会错位
    const counts = Object.create(null);
    for (const c of kept) {
      counts[c.kind] = (counts[c.kind] || 0) + 1;
      c.nth = counts[c.kind];
    }

    scoreAll(kept);
    return kept;
  }

  function scoreAll(list) {
    const state = window.__WB__ && window.__WB__.state;
    const lastFocus = state && state.lastFocus;
    for (const c of list) {
      let s = c.area / 1000;
      s += specs.CAT_WEIGHT[c.cat] || 0;
      if (c.focused) s += 1000;
      else if (lastFocus && lastFocus.isConnected) {
        try {
          if (c.el === lastFocus || c.el.contains(lastFocus)) s += 600;
        } catch (_) {}
      }
      if (c.ariaHidden) s -= 200;
      if (c.readonly) s -= 400;
      // 单行框天然比多行框差一档，压一点，避免抢走聊天框
      if (c.kind === 'input') s -= 40;
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
