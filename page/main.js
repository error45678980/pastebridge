/* 贴进去 · PasteBridge — 门面
 *
 * 唯一暴露给 popup 的入口：window.__WB__.run(payload)
 * 所有返回值必须是 JSON 可序列化的，因为要穿过 executeScript 边界。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  if (!NS.core || !NS.specs || !NS.detect || !NS.methods || !NS.insert || !NS.picker) return;

  const core = NS.core;
  const specs = NS.specs;
  const detect = NS.detect;
  const insert = NS.insert;
  const picker = NS.picker;
  const V = '2.1.3';

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
        const hit = core.closestDeep(t, specs.FOCUS_SEL);
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
        cat: c.cat,
        name: c.name,
        nth: c.nth,
        readonly: c.readonly,
        focused: c.focused,
        score: Math.round(c.score)
      })),
      primary: best ? list.indexOf(best) : null,
      focused: !!(best && best.focused),
      iframes: document.querySelectorAll('iframe').length,
      picked: F.state.picked,
      lastStatus: F.state.lastStatus
    };
  }

  /* 供跨帧扫描用：只报告本帧的候选，由 SW 汇总 */
  function scanSelf() {
    const list = detect.detect();
    return {
      ok: true,
      v: V,
      isTop: window === window.top,
      href: location.href,
      count: list.length,
      choices: list.map((c, i) => ({
        i,
        kind: c.kind,
        cat: c.cat,
        label: c.label,
        name: c.name,
        nth: c.nth,
        readonly: c.readonly,
        focused: c.focused,
        score: Math.round(c.score)
      }))
    };
  }

  /* 选目标：显式指定 > 当前聚焦 > 站点记忆 > 唯一候选 > 打分明显领先 > 点选
   *
   * 显式指定必须用 {kind, nth} 而不是数组下标：
   * 候选列表每次都是重新扫描的，焦点一变、单行输入框的过滤规则就会变，
   * 下标会漂移，可能把内容插进另一个编辑器。
   */
  function findChoice(list, sel) {
    if (sel == null) return null;
    if (typeof sel === 'number') return list[sel] || null;
    if (typeof sel === 'object' && sel.kind) {
      return list.find((c) => c.kind === sel.kind && (sel.nth == null || c.nth === sel.nth)) || null;
    }
    return null;
  }

  function choose(list, payload) {
    const explicit = findChoice(list, payload.choice);
    if (explicit) return { target: explicit, mode: 'explicit' };
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
      partial: !!r.partial,
      reason: r.reason || null,
      ts: Date.now()
    };

    if (r.ok && r.partial) {
      // 方法中途抛异常、但内容已经变了：不敢说成功，也不敢说失败
      core.toast('可能只插入了一部分，请检查（' + labelOf(r.kind) + '）', 'err', 4200);
    } else if (r.ok) {
      const tag =
        r.verified === 'strict' ? '' : r.verified === 'weak' ? ' · 弱校验' : ' · 未校验';
      const flat = r.flat ? ' · 单行框，换行已转空格' : '';
      core.toast('已插入 ' + r.chars + ' 字符 · ' + labelOf(r.kind) + tag + flat, 'ok', 2200);
    } else {
      core.toast('插入失败：' + reasonText(r.reason), 'err', 3600);
    }
  }

  /* 聊天框里插多行代码，围栏由扩展代劳。
   * 代码编辑器里绝不包裹——那里要的是裸代码。 */
  function wrapFor(cat, code, md) {
    if (!md || !md.on) return code;
    if (cat !== 'rich') return code;
    const lang = String(md.lang || '').trim();
    return '```' + lang + '\n' + code + '\n```';
  }

  async function doInsert(payload) {
    const code = String(payload && payload.code != null ? payload.code : '');
    if (!code) {
      core.toast('没有内容可插入', 'err', 1800);
      return { ok: false, reason: 'empty' };
    }

    // 显式指定目标时要保留低优先级候选（单行输入框失焦后会被过滤掉）
    const list = detect.detect({ includeLowPriority: !!payload.choice });
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
          const r = await insert.insertInto(c, wrapFor(c.cat, code, payload.md));
          report(r);
        },
        () => core.toast('已取消', 'info', 1500)
      );
      return { ok: true, pending: true, count: shown.length };
    }

    const r = await insert.insertInto(picked.target, wrapFor(picked.target.cat, code, payload.md));
    report(r);
    return r;
  }

  /* ---------------- 盲插：不指定目标，直接打到当前焦点 ----------------
   *
   * 只用于 detect() 一个候选都找不到的情况（编辑器在 closed shadow DOM 里、
   * 或是自研控件没暴露任何可识别特征）。此时 execCommand 作用于「文档当前焦点」，
   * 不受 shadow 边界限制——但前提是用户已经自己把光标点进去了。
   */
  function readEditable(node) {
    if (!node || node.nodeType !== 1) return null;
    try {
      if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') return String(node.value);
      if (node.isContentEditable) return String(node.innerText);
    } catch (_) {}
    return null;
  }

  async function blindInsert(payload) {
    const code = String(payload && payload.code != null ? payload.code : '');
    if (!code) return { ok: false, reason: 'empty' };

    /* 弹窗打开时页面没有焦点，编辑命令会直接失败。
     * 这里只把窗口焦点抢回来，**不 focus 任何元素**——那会丢掉用户已经放好的选区。 */
    if (!document.hasFocus()) {
      try {
        window.focus();
      } catch (_) {}
      const t0 = Date.now();
      while (!document.hasFocus() && Date.now() - t0 < 350) {
        await core.sleep(50);
      }
    }

    const el = core.activeElementDeep();
    if (!el || el === document.body || el === document.documentElement) {
      return { ok: false, kind: 'blind', method: 'blind-exec', verified: 'none', reason: 'no-focus' };
    }

    const before = readEditable(el);
    let ret = false;
    try {
      ret = document.execCommand('insertText', false, code);
    } catch (_) {}

    await core.frames(2);
    const after = readEditable(el);

    /* 目标可读：精确比对 */
    if (before != null && after != null) {
      const changed = after !== before;
      return {
        ok: changed,
        kind: 'blind',
        method: 'blind-exec',
        verified: changed ? 'strict' : 'none',
        chars: code.length,
        reason: changed ? undefined : 'blind-no-change'
      };
    }

    /* 目标在 closed shadow 里：拿不到元素引用就读不到值。
     * 这时只有 execCommand 的返回值可参考，它只代表「命令被执行」，
     * 所以只能诚实地说「已尝试、未校验」。 */
    if (ret) {
      return { ok: true, kind: 'blind', method: 'blind-exec', verified: 'uncertain', chars: code.length };
    }
    return {
      ok: false,
      kind: 'blind',
      method: 'blind-exec',
      verified: 'none',
      chars: code.length,
      reason: 'blind-failed'
    };
  }

  /* 键入前把焦点落到目标上：CDP 的 Input 只进「当前焦点」，
   * 跨帧键入时尤其要先在这一帧里 focus，否则字符会打到顶层。 */
  function focusTarget(payload) {
    const list = detect.detect({ includeLowPriority: !!payload.choice });
    const picked = choose(list, payload);
    if (!picked.target) return { ok: false, reason: 'no-target' };
    try {
      picked.target.el.focus({ preventScroll: true });
    } catch (_) {
      try {
        picked.target.el.focus();
      } catch (_) {}
    }
    return { ok: true, kind: picked.target.kind, frameId: payload.frameId };
  }

  /* 键入前回读目标文本，用来判断「是不是其实已经插进去了」，避免重复打一遍 */
  function probeText(payload) {
    const list = detect.detect({ includeLowPriority: !!payload.choice });
    const picked = choose(list, payload);
    if (!picked.target) return { ok: false, reason: 'no-target' };
    const text = insert.readText(picked.target);
    return {
      ok: true,
      kind: picked.target.kind,
      chars: text == null ? 0 : String(text).length,
      text: text == null ? '' : String(text).slice(0, 4000)
    };
  }

  /* 抓取当前选区：这是唯一不需要任何额外权限的捕获通道，
   * activeTab 就够——用户在哪儿选中，就把哪儿的内容收进剪贴板历史。 */
  function grabSelection() {
    let text = '';
    try {
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) {
        const s = a.selectionStart;
        const e = a.selectionEnd;
        if (typeof s === 'number' && typeof e === 'number' && e > s) {
          text = String(a.value).slice(s, e);
        }
      }
    } catch (_) {}
    if (!text) {
      try {
        text = String(window.getSelection() || '');
      } catch (_) {}
    }
    return { ok: true, text: text, title: document.title, url: location.href };
  }

  /* 让页面自己弹一条提示：键入可能耗时几秒，弹窗中途被关掉时这是唯一的反馈 */
  function toastSelf(payload) {
    core.toast(String((payload && payload.text) || ''), (payload && payload.kind) || 'info', (payload && payload.ms) || 2200);
    return { ok: true };
  }

  async function run(payload) {
    const op = payload && payload.op;
    try {
      if (op === 'precheck') return precheck();
      if (op === 'scan') return scanSelf();
      if (op === 'grab') return grabSelection();
      if (op === 'blind') return await blindInsert(payload);
      if (op === 'probe') return probeText(payload);
      if (op === 'focus') return focusTarget(payload);
      if (op === 'toast') return toastSelf(payload);
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
