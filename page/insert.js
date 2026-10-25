/* 贴进去 · PasteBridge — 插入策略阶梯
 *
 * 原则：
 * 1. 绝不合成 paste 事件。站点拦的就是 paste，合成了照样被 preventDefault。
 * 2. 原生实例 API 优先（多行、缩进、撤销栈最准），execCommand 是主力通道。
 * 3. 每次插入后回读文本校验；只有「完全没产生变化」才升级到下一个方法，
 *    内容变了但不匹配就立即停手并如实上报，避免重复插入。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const core = NS.core;
  const CHUNK = 20000;

  /* ---------------- 基础动作 ---------------- */

  function focusNode(node) {
    try {
      node.focus({ preventScroll: true });
    } catch (_) {
      try {
        node.focus();
      } catch (_) {}
    }
  }

  function execInsert(text) {
    if (typeof document.execCommand !== 'function') return false;
    try {
      return document.execCommand('insertText', false, text);
    } catch (_) {
      return false;
    }
  }

  async function focusAndSettle(node) {
    focusNode(node);
    await core.frames(2);
    // 弹窗占着焦点时，页面里的 focus() 可能先让弹窗关闭、焦点随后才回到页面。
    // 给它一点时间落定，否则部分编辑器会忽略输入。
    if (!document.hasFocus()) {
      const t0 = Date.now();
      while (!document.hasFocus() && Date.now() - t0 < 350) {
        await core.sleep(50);
      }
      focusNode(node);
      await core.frames(1);
    }
  }

  function splitChunks(text, size) {
    if (text.length <= size) return [text];
    const out = [];
    let rest = text;
    while (rest.length > size) {
      let cut = rest.lastIndexOf('\n', size);
      if (cut < size * 0.5) cut = size - 1;
      const piece = rest.slice(0, cut + 1);
      out.push(piece);
      rest = rest.slice(piece.length);
    }
    if (rest) out.push(rest);
    return out;
  }

  async function execChunked(node, code) {
    for (const part of splitChunks(code, CHUNK)) {
      focusNode(node);
      if (!execInsert(part)) return false;
      await core.nextFrame();
    }
    return true;
  }

  /* ---------------- 实例探针（MAIN 世界才有效） ---------------- */

  function cm6View(c) {
    const probes = [];
    try {
      const content = c.el.querySelector('.cm-content');
      if (content) {
        // CM6 把 EditorView 挂在内容节点的 cmTile.view 上
        probes.push(content.cmTile, content.cmView);
      }
      probes.push(c.el.cmTile, c.el.cmView);
    } catch (_) {}
    for (const p of probes) {
      try {
        const v = (p && p.view) || (p && p.rootView && p.rootView.view) || null;
        if (v && v.state && v.state.doc && typeof v.dispatch === 'function') return v;
      } catch (_) {}
    }
    return null;
  }

  function monacoEditor(c) {
    try {
      const api = window.monaco && window.monaco.editor;
      if (!api || typeof api.getEditors !== 'function') return null;
      const eds = api.getEditors() || [];
      for (const ed of eds) {
        let dom = null;
        try {
          dom = typeof ed.getDomNode === 'function' ? ed.getDomNode() : null;
        } catch (_) {}
        if (dom && (dom === c.el || c.el.contains(dom) || dom.contains(c.el))) return ed;
      }
      return eds.length === 1 ? eds[0] : null;
    } catch (_) {
      return null;
    }
  }

  function monacoTextarea(el) {
    return el.querySelector('textarea.inputarea') || el.querySelector('textarea');
  }

  /* ---------------- 回读与校验 ---------------- */

  function readText(c) {
    try {
      switch (c.kind) {
        case 'cm5': {
          const cm = c.el.CodeMirror;
          if (cm && typeof cm.getValue === 'function') return cm.getValue();
          // 拿不到实例时，textarea 里只是输入缓冲，不是文档本身。
          // 退而读代码区文本：textContent 不依赖布局，也不会带上行号栏。
          const codeEl = c.el.querySelector('.CodeMirror-code') || c.el;
          return codeEl.textContent || codeEl.innerText || null;
        }
        case 'ace': {
          const ed = c.el.env && c.el.env.editor;
          if (ed && typeof ed.getValue === 'function') return ed.getValue();
          const layer = c.el.querySelector('.ace_text-layer') || c.el;
          return layer.textContent || layer.innerText || null;
        }
        case 'cm6': {
          const v = cm6View(c);
          if (v) return v.state.doc.toString();
          const content = c.el.querySelector('.cm-content');
          return content ? content.textContent || content.innerText || '' : null;
        }
        case 'monaco': {
          const ed = monacoEditor(c);
          if (ed) return ed.getValue();
          const lines = c.el.querySelector('.view-lines') || c.el;
          return lines.textContent || lines.innerText || '';
        }
        case 'textarea':
          return c.el.value;
        case 'ce':
          return c.el.innerText || c.el.textContent || '';
      }
    } catch (_) {}
    return null;
  }

  function verify(code, text, before) {
    if (text == null) return 'none';
    const a = core.squash(text);
    const b = core.squash(code);
    if (!b) return text === code ? 'strict' : 'none';
    if (a.includes(b)) return 'strict';
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

  /* ---------------- 各编辑器的方法阶梯 ---------------- */

  function cm5Methods(c, code) {
    return [
      {
        name: 'cm5-api',
        run: async () => {
          const cm = c.el.CodeMirror;
          if (!cm || typeof cm.replaceSelection !== 'function') return false;
          if (typeof cm.getOption === 'function' && cm.getOption('readOnly')) return false;
          cm.focus();
          cm.replaceSelection(code);
          return true;
        }
      },
      {
        name: 'cm5-exec',
        run: async () => {
          const ta = c.el.querySelector('textarea');
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  function cm6Methods(c, code) {
    return [
      {
        name: 'cm6-api',
        run: async () => {
          const v = cm6View(c);
          if (!v || typeof v.state.replaceSelection !== 'function') return false;
          v.focus();
          v.dispatch(v.state.replaceSelection(code));
          return true;
        }
      },
      {
        name: 'cm6-exec',
        run: async () => {
          const content = c.el.querySelector('.cm-content');
          if (!content) return false;
          await focusAndSettle(content);
          return code.length <= CHUNK ? execInsert(code) : execChunked(content, code);
        }
      },
      {
        name: 'cm6-lines',
        run: async () => {
          const content = c.el.querySelector('.cm-content');
          if (!content) return false;
          await focusAndSettle(content);
          const lines = code.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) document.execCommand('insertLineBreak');
            if (lines[i]) execInsert(lines[i]);
            await core.nextFrame();
          }
          return true;
        }
      }
    ];
  }

  function monacoMethods(c, code) {
    return [
      {
        name: 'monaco-api',
        run: async () => {
          const ed = monacoEditor(c);
          if (!ed) return false;
          const model = ed.getModel();
          if (!model) return false;
          let range = null;
          try {
            range = ed.getSelection();
          } catch (_) {}
          if (!range) {
            range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
          }
          ed.executeEdits('pastebridge', [{ range, text: code, forceMoveMarkers: true }]);
          try {
            ed.pushUndoStop();
          } catch (_) {}
          ed.focus();
          return true;
        }
      },
      {
        name: 'monaco-exec',
        run: async () => {
          const ta = monacoTextarea(c.el);
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  function aceMethods(c, code) {
    return [
      {
        name: 'ace-api',
        run: async () => {
          const ed = c.el.env && c.el.env.editor;
          if (!ed || typeof ed.insert !== 'function') return false;
          if (typeof ed.getReadOnly === 'function' && ed.getReadOnly()) return false;
          ed.focus();
          let sel = null;
          try {
            sel = ed.getSelectionRange();
          } catch (_) {}
          if (sel && typeof sel.isEmpty === 'function' && !sel.isEmpty()) {
            ed.session.replace(sel, code);
          } else {
            ed.insert(code);
          }
          return true;
        }
      },
      {
        name: 'ace-exec',
        run: async () => {
          const ta = c.el.querySelector('.ace_text-input') || c.el.querySelector('textarea');
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  function textareaMethods(c, code) {
    return [
      {
        name: 'ta-exec',
        run: async () => {
          if (code.length > CHUNK) return false;
          await focusAndSettle(c.el);
          return execInsert(code);
        }
      },
      {
        name: 'ta-setrange',
        run: async () => {
          const ta = c.el;
          focusNode(ta);
          const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
          const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
          ta.setRangeText(code, start, end, 'end');
          try {
            ta.dispatchEvent(
              new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code })
            );
          } catch (_) {}
          return true;
        }
      }
    ];
  }

  function ceMethods(c, code) {
    return [
      {
        name: 'ce-exec',
        run: async () => {
          await focusAndSettle(c.el);
          return code.length <= CHUNK ? execInsert(code) : execChunked(c.el, code);
        }
      },
      {
        name: 'ce-range',
        run: async () => {
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return false;
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const frag = document.createDocumentFragment();
          const lines = code.split('\n');
          lines.forEach((line, i) => {
            if (i > 0) frag.appendChild(document.createElement('br'));
            frag.appendChild(document.createTextNode(line));
          });
          const last = frag.lastChild;
          range.insertNode(frag);
          if (last) {
            const r2 = document.createRange();
            r2.setStartAfter(last);
            r2.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r2);
          }
          try {
            c.el.dispatchEvent(
              new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code })
            );
          } catch (_) {}
          return true;
        }
      }
    ];
  }

  function methodsFor(c, code) {
    switch (c.kind) {
      case 'cm5':
        return cm5Methods(c, code);
      case 'cm6':
        return cm6Methods(c, code);
      case 'monaco':
        return monacoMethods(c, code);
      case 'ace':
        return aceMethods(c, code);
      case 'textarea':
        return textareaMethods(c, code);
      default:
        return ceMethods(c, code);
    }
  }

  /* ---------------- 驱动 ---------------- */

  async function insertInto(c, code) {
    const t0 = performance.now();
    const text = String(code == null ? '' : code).replace(/\r\n/g, '\n');
    const methods = methodsFor(c, text);
    let reason = '';

    for (const m of methods) {
      const before = readText(c);
      let ok = false;
      try {
        ok = await m.run();
      } catch (e) {
        reason = m.name + ': ' + ((e && e.message) || e);
        continue;
      }
      if (ok === false) {
        reason = m.name + ': 不可用';
        continue;
      }
      await core.frames(2);

      const after = readText(c);
      const changed = before == null || after == null ? true : after !== before;
      const v = verify(text, after, before);

      if (v === 'strict' || v === 'weak' || changed) {
        return {
          ok: true,
          kind: c.kind,
          method: m.name,
          verified: v,
          chars: text.length,
          ms: Math.round(performance.now() - t0)
        };
      }
      reason = m.name + ': 无变化';
    }

    return {
      ok: false,
      kind: c.kind,
      method: null,
      verified: 'none',
      chars: text.length,
      ms: Math.round(performance.now() - t0),
      reason: reason || '没有可用的插入方式'
    };
  }

  NS.insert = { insertInto, readText, verify, cm6View, monacoEditor, focusNode };
})();
