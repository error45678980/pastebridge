/* 贴进去 · PasteBridge — 插入驱动与校验
 *
 * 这里只做三件事：调度方法阶梯、回读、判定成败。
 * 具体每种编辑器怎么插，全部在 page/methods.js 里。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const core = NS.core;
  const methods = NS.methods;

  function readText(c) {
    return methods.read(c.kind, c.el);
  }

  function countLines(s) {
    if (s == null) return 0;
    return String(s).replace(/\r\n/g, '\n').split('\n').length;
  }

  /* v1 的 squash() 抹掉了所有空白——包括换行。
   * 于是「换行全丢、代码挤成一行」也会命中 a.includes(b)，被判成 strict，
   * 这种 bug 会一直伪装成成功。v2 因此加了行数结构校验。 */
  function verify(code, text, before) {
    if (text == null) return 'none';
    const a = core.squash(text);
    const b = core.squash(code);
    if (!b) return text === code ? 'strict' : 'none';

    const wantLines = countLines(code);
    const gotLines = countLines(text);
    const lineOk =
      wantLines <= 1 || Math.abs(gotLines - wantLines) <= Math.max(1, Math.round(wantLines * 0.1));

    if (a.includes(b)) return lineOk ? 'strict' : 'weak';
    if (b.length > 40 && a.includes(b.slice(-24))) return 'weak';

    // 虚拟化渲染的编辑器（Ace / Monaco）在后台标签页里可能还没把文本画进 DOM，
    // 这时用长度增量兜一层：文档确实长出了差不多这么多字符，就算弱校验通过。
    if (before != null) {
      const delta = text.length - before.length;
      const tol = Math.max(4, Math.round(code.length * 0.15));
      if (delta > 0 && Math.abs(delta - code.length) <= tol) return 'weak';
    }
    return 'none';
  }

  async function insertInto(c, code) {
    const t0 = performance.now();
    const raw = String(code == null ? '' : code).replace(/\r\n/g, '\n');
    // 单行框会把换行压成空格（这是设计行为），校验也得按压平后的文本比对，
    // 否则会一直报「弱校验」，让人误以为插入不完整。
    const isInput = c.kind === 'input';
    const flatText = isInput ? raw.replace(/\n/g, ' ') : raw;
    const list = methods.methodsFor(c.kind, c.el, raw);
    const attempts = [];
    let reason = '';

    const done = (extra) =>
      Object.assign(
        {
          ok: true,
          kind: c.kind,
          chars: raw.length,
          flat: isInput && raw.indexOf('\n') >= 0 ? true : undefined,
          attempts: attempts,
          partial: false,
          ms: Math.round(performance.now() - t0)
        },
        extra
      );

    for (const m of list) {
      const before = readText(c);
      let ok = false;
      try {
        ok = await m.run();
      } catch (e) {
        /* 方法抛异常时可能已经写进去了一部分。必须先回读确认——
         * 否则下一个方法会把同样的内容再插一遍，用户得到两份。 */
        await core.frames(2);
        const mid = readText(c);
        const touched = before != null && mid != null && mid !== before;
        attempts.push({ name: m.name, outcome: 'error' });
        if (touched) {
          return done({
            method: m.name,
            verified: verify(flatText, mid, before),
            partial: true,
            reason: 'method-threw-after-change'
          });
        }
        reason = m.name + ': ' + ((e && e.message) || e);
        continue;
      }
      if (ok === false) {
        attempts.push({ name: m.name, outcome: 'unavailable' });
        reason = m.name + ': 不可用';
        continue;
      }

      await core.frames(2);

      let after = readText(c);
      let changed = before == null || after == null ? true : after !== before;

      // 富文本框架常在 microtask / rAF 之后才把内容落地。
      // 只等两帧就下「没变化」的结论，会导致误判并插入第二遍。
      if (!changed) {
        await core.sleep(120);
        await core.frames(1);
        after = readText(c);
        changed = before == null || after == null ? true : after !== before;
      }

      const v = verify(flatText, after, before);

      if (v === 'strict' || v === 'weak' || changed) {
        attempts.push({ name: m.name, outcome: changed ? 'changed' : 'no-change' });
        return done({ method: m.name, verified: v });
      }
      attempts.push({ name: m.name, outcome: 'no-change' });
      reason = m.name + ': 无变化';
    }

    return {
      ok: false,
      kind: c.kind,
      method: null,
      verified: 'none',
      chars: raw.length,
      attempts: attempts,
      partial: false,
      ms: Math.round(performance.now() - t0),
      reason: reason || '没有可用的插入方式'
    };
  }

  NS.insert = {
    insertInto,
    readText,
    verify,
    countLines,
    cm6View: methods.cm6View,
    monacoEditor: methods.monacoEditor,
    focusNode: methods.focusNode
  };
})();
