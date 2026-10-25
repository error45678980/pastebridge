/* 贴进去 · PasteBridge — 各编辑器的插入方法阶梯
 *
 * 原则（v1 沿用，v2 加固）：
 * 1. 绝不合成 paste 事件。站点拦的就是 paste，合成了照样被 preventDefault。
 * 2. execCommand('insertText') 是主力通道——它触发的是**可信** beforeinput/input，
 *    ProseMirror / Lexical / Slate / Draft 都会当成真人输入，比合成事件可靠得多。
 * 3. 每次插入后回读校验；只有「完全没产生变化」才升级到下一个方法，
 *    内容变了但不匹配就立即停手并如实上报，避免重复插入。
 *
 * 阶梯顺序（自上而下）：
 *   原生实例 API → 整段 execCommand → 逐行 insertLineBreak → beforeinput+DataTransfer → Range
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

  function execLineBreak() {
    try {
      return document.execCommand('insertLineBreak');
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

  /* 逐行插入：行间用 insertLineBreak（等价于 Shift+Enter），
   * 不会触发 keydown，所以绝不会误触「回车发送」。 */
  async function insertLineByLine(node, code) {
    await focusAndSettle(node);
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) execLineBreak();
      if (lines[i]) execInsert(lines[i]);
      await core.nextFrame();
    }
    return true;
  }

  /* ---------------- 实例探针（仅 MAIN 世界有效） ---------------- */

  function cm6View(el) {
    const probes = [];
    try {
      const content = el.querySelector('.cm-content');
      if (content) {
        // CM6 把 EditorView 挂在内容节点的 cmTile.view 上
        probes.push(content.cmTile, content.cmView);
      }
      probes.push(el.cmTile, el.cmView);
    } catch (_) {}
    for (const p of probes) {
      try {
        const v = (p && p.view) || (p && p.rootView && p.rootView.view) || null;
        if (v && v.state && v.state.doc && typeof v.dispatch === 'function') return v;
      } catch (_) {}
    }
    return null;
  }

  function monacoEditor(el) {
    try {
      const api = window.monaco && window.monaco.editor;
      if (!api || typeof api.getEditors !== 'function') return null;
      const eds = api.getEditors() || [];
      for (const ed of eds) {
        let dom = null;
        try {
          dom = typeof ed.getDomNode === 'function' ? ed.getDomNode() : null;
        } catch (_) {}
        if (dom && (dom === el || el.contains(dom) || dom.contains(el))) return ed;
      }
      return eds.length === 1 ? eds[0] : null;
    } catch (_) {
      return null;
    }
  }

  function monacoTextarea(el) {
    return el.querySelector('textarea.inputarea') || el.querySelector('textarea');
  }

  function quillEditor(el) {
    try {
      const Q = window.Quill;
      if (!Q || typeof Q.find !== 'function') return null;
      return Q.find(el) || null;
    } catch (_) {
      return null;
    }
  }

  /* ---------------- 回读 ---------------- */

  function read(kind, el) {
    try {
      switch (kind) {
        case 'cm5': {
          const cm = el.CodeMirror;
          if (cm && typeof cm.getValue === 'function') return cm.getValue();
          // 拿不到实例时，textarea 里只是输入缓冲，不是文档本身。
          // 退而读代码区文本：textContent 不依赖布局，也不会带上行号栏。
          const codeEl = el.querySelector('.CodeMirror-code') || el;
          return codeEl.textContent || codeEl.innerText || null;
        }
        case 'ace': {
          const ed = el.env && el.env.editor;
          if (ed && typeof ed.getValue === 'function') return ed.getValue();
          const layer = el.querySelector('.ace_text-layer') || el;
          return layer.textContent || layer.innerText || null;
        }
        case 'cm6': {
          const v = cm6View(el);
          if (v) return v.state.doc.toString();
          const content = el.querySelector('.cm-content');
          return content ? content.textContent || content.innerText || '' : null;
        }
        case 'monaco': {
          const ed = monacoEditor(el);
          if (ed) return ed.getValue();
          const lines = el.querySelector('.view-lines') || el;
          return lines.textContent || lines.innerText || '';
        }
        case 'textarea':
        case 'input':
          return el.value;
        default:
          // 所有富文本 / 聊天框：innerText 会把 <br> 和块级边界还原成 \n
          return el.innerText || el.textContent || '';
      }
    } catch (_) {}
    return null;
  }

  /* ---------------- 代码编辑器阶梯 ---------------- */

  function cm5Methods(el, code) {
    return [
      {
        name: 'cm5-api',
        run: async () => {
          const cm = el.CodeMirror;
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
          const ta = el.querySelector('textarea');
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  function cm6Methods(el, code) {
    return [
      {
        name: 'cm6-api',
        run: async () => {
          const v = cm6View(el);
          if (!v || typeof v.state.replaceSelection !== 'function') return false;
          v.focus();
          v.dispatch(v.state.replaceSelection(code));
          return true;
        }
      },
      {
        name: 'cm6-exec',
        run: async () => {
          const content = el.querySelector('.cm-content');
          if (!content) return false;
          await focusAndSettle(content);
          return code.length <= CHUNK ? execInsert(code) : execChunked(content, code);
        }
      },
      {
        name: 'cm6-lines',
        run: async () => {
          const content = el.querySelector('.cm-content');
          if (!content) return false;
          return insertLineByLine(content, code);
        }
      }
    ];
  }

  function monacoMethods(el, code) {
    return [
      {
        name: 'monaco-api',
        run: async () => {
          const ed = monacoEditor(el);
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
          const ta = monacoTextarea(el);
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  function aceMethods(el, code) {
    return [
      {
        name: 'ace-api',
        run: async () => {
          const ed = el.env && el.env.editor;
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
          const ta = el.querySelector('.ace_text-input') || el.querySelector('textarea');
          if (!ta) return false;
          await focusAndSettle(ta);
          return code.length <= CHUNK ? execInsert(code) : execChunked(ta, code);
        }
      }
    ];
  }

  /* ---------------- 原生控件阶梯 ---------------- */

  /* React 受控组件：直接 el.value = x 会被 valueTracker 认为「没变」，onChange 不触发。
   * 必须走原型上的 setter，让 React 看到一次真实的赋值。 */
  function setNativeValue(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, value);
        return true;
      }
    } catch (_) {}
    try {
      el.value = value;
      return true;
    } catch (_) {
      return false;
    }
  }

  function fireInput(el, code) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code }));
    } catch (_) {}
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  function textareaMethods(el, code) {
    return [
      {
        name: 'ta-exec',
        run: async () => {
          if (code.length > CHUNK) return false;
          await focusAndSettle(el);
          return execInsert(code);
        }
      },
      {
        name: 'ta-setrange',
        run: async () => {
          focusNode(el);
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          el.setRangeText(code, start, end, 'end');
          fireInput(el, code);
          return true;
        }
      },
      {
        name: 'ta-setter',
        run: async () => {
          focusNode(el);
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          const next = el.value.slice(0, start) + code + el.value.slice(end);
          if (!setNativeValue(el, next)) return false;
          try {
            el.selectionStart = el.selectionEnd = start + code.length;
          } catch (_) {}
          fireInput(el, code);
          return true;
        }
      }
    ];
  }

  function inputMethods(el, code) {
    // 单行框装不下换行：换成空格，并在结果里标明，免得用户以为是丢字
    const flat = code.replace(/\r?\n/g, ' ');
    return [
      {
        name: 'input-exec',
        run: async () => {
          await focusAndSettle(el);
          return execInsert(flat);
        }
      },
      {
        name: 'input-setter',
        run: async () => {
          focusNode(el);
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          const next = el.value.slice(0, start) + flat + el.value.slice(end);
          if (!setNativeValue(el, next)) return false;
          try {
            el.selectionStart = el.selectionEnd = start + flat.length;
          } catch (_) {}
          fireInput(el, flat);
          return true;
        }
      }
    ];
  }

  /* ---------------- 富文本 / 聊天框阶梯 ---------------- */

  function beforeInputPaste(el, code) {
    let dt = null;
    try {
      dt = new DataTransfer();
      dt.setData('text/plain', code);
    } catch (_) {
      return false;
    }
    let ev = null;
    try {
      ev = new InputEvent('beforeinput', {
        inputType: 'insertFromPaste',
        dataTransfer: dt,
        bubbles: true,
        cancelable: true
      });
    } catch (_) {
      return false;
    }
    // 构造器不认 dataTransfer 时，事件里就没有数据，别浪费一轮
    if (!ev.dataTransfer) return false;
    try {
      el.dispatchEvent(ev);
      return true;
    } catch (_) {
      return false;
    }
  }

  function rangeInsert(el, code) {
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
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: code }));
    } catch (_) {}
    return true;
  }

  function richMethods(kind, el, code) {
    const list = [];

    // 1) 原生实例（只有 Quill 有可靠的公开实例通道，其余靠 execCommand 更稳）
    if (kind === 'quill') {
      list.push({
        name: 'quill-api',
        run: async () => {
          const q = quillEditor(el);
          if (!q || typeof q.insertText !== 'function') return false;
          q.focus();
          let idx = 0;
          try {
            const sel = q.getSelection(true);
            idx = sel && typeof sel.index === 'number' ? sel.index : q.getLength();
          } catch (_) {}
          q.insertText(idx, code, 'user');
          return true;
        }
      });
    }

    // 2) / 3) 整段 execCommand 与逐行的先后顺序，取决于有没有空行。
    // contenteditable 里一个「空行」需要两个 <br> 才撑得开，
    // 所以整段 insertText 会把 \n\n 变成 \n\n\n（多出一个空行）。
    // 逐行 insertLineBreak 则是精确的。实测：整段 9 行 vs 逐行 7 行，后者与原文一致。
    const multiline = code.indexOf('\n') >= 0;
    const hasBlankLine = /\n[ \t]*\n/.test(code);

    const whole = {
      name: kind + '-exec',
      run: async () => {
        await focusAndSettle(el);
        return code.length <= CHUNK ? execInsert(code) : execChunked(el, code);
      }
    };

    const lines = {
      name: kind + '-lines',
      run: async () => insertLineByLine(el, code)
    };

    if (multiline && hasBlankLine) {
      // 空行场景：逐行优先，整段退居备选
      list.push(lines, whole);
    } else {
      list.push(whole);
      if (multiline) list.push(lines);
    }

    // 4) beforeinput + DataTransfer —— Lexical / ProseMirror 的粘贴通道
    list.push({
      name: kind + '-beforeinput',
      run: async () => {
        await focusAndSettle(el);
        return beforeInputPaste(el, code);
      }
    });

    // 5) Range 兜底 —— 会与框架状态脱钩，只在前几级全无变化时用
    list.push({
      name: kind + '-range',
      run: async () => {
        await focusAndSettle(el);
        return rangeInsert(el, code);
      }
    });

    return list;
  }

  /* ---------------- 调度 ---------------- */

  function methodsFor(kind, el, code) {
    switch (kind) {
      case 'cm5':
        return cm5Methods(el, code);
      case 'cm6':
        return cm6Methods(el, code);
      case 'monaco':
        return monacoMethods(el, code);
      case 'ace':
        return aceMethods(el, code);
      case 'textarea':
        return textareaMethods(el, code);
      case 'input':
        return inputMethods(el, code);
      default:
        return richMethods(kind, el, code);
    }
  }

  NS.methods = {
    methodsFor,
    read,
    focusNode,
    focusAndSettle,
    execInsert,
    cm6View,
    monacoEditor,
    CHUNK
  };
})();
