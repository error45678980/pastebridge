/* 贴进去 · PasteBridge — 键入计划器（纯函数，零 chrome API）
 *
 * 把一段文本翻译成 CDP 命令序列。
 *
 * 为什么单独拆成纯函数：Playwright 自己通过 CDP 控制页面，
 * 扩展的 chrome.debugger 在自动化环境里往往附不上。但「命令序列对不对」
 * 完全可以在 Node 里断言——换行是不是 Shift+Enter、Tab 有没有被发出去、
 * emoji 有没有被切碎。这些才是真正容易错的地方。
 *
 * 三条铁律：
 * 1. 换行只发 Shift+Enter，**绝不发裸 Enter**（聊天框会直接发送）。
 * 2. Tab 绝不发 VK 9（默认动作会把焦点移出编辑器），一律替换成空格。
 * 3. 非 ASCII 不走按键，攒起来走 Input.insertText（没有对应 VK 码）。
 */
(() => {
  'use strict';

  const SHIFT = 8;

  /* US 布局：可打印 ASCII → [code, windowsVirtualKeyCode, 是否需要 Shift] */
  const PUNCT = {
    ' ': ['Space', 32, false],
    '!': ['Digit1', 49, true],
    '"': ['Quote', 222, true],
    '#': ['Digit3', 51, true],
    $: ['Digit4', 52, true],
    '%': ['Digit5', 53, true],
    '&': ['Digit7', 55, true],
    "'": ['Quote', 222, false],
    '(': ['Digit9', 57, true],
    ')': ['Digit0', 48, true],
    '*': ['Digit8', 56, true],
    '+': ['Equal', 187, true],
    ',': ['Comma', 188, false],
    '-': ['Minus', 189, false],
    '.': ['Period', 190, false],
    '/': ['Slash', 191, false],
    ':': ['Semicolon', 186, true],
    ';': ['Semicolon', 186, false],
    '<': ['Comma', 188, true],
    '=': ['Equal', 187, false],
    '>': ['Period', 190, true],
    '?': ['Slash', 191, true],
    '@': ['Digit2', 50, true],
    '[': ['BracketLeft', 219, false],
    '\\': ['Backslash', 220, false],
    ']': ['BracketRight', 221, false],
    '^': ['Digit6', 54, true],
    _: ['Minus', 189, true],
    '`': ['Backquote', 192, false],
    '{': ['BracketLeft', 219, true],
    '|': ['Backslash', 220, true],
    '}': ['BracketRight', 221, true],
    '~': ['Backquote', 192, true]
  };

  function keyInfo(ch) {
    if (ch >= 'a' && ch <= 'z') {
      return { code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), shift: false };
    }
    if (ch >= 'A' && ch <= 'Z') {
      return { code: 'Key' + ch, vk: ch.charCodeAt(0), shift: true };
    }
    if (ch >= '0' && ch <= '9') {
      return { code: 'Digit' + ch, vk: ch.charCodeAt(0), shift: false };
    }
    const p = PUNCT[ch];
    if (p) return { code: p[0], vk: p[1], shift: p[2] };
    return null;
  }

  /* 按 grapheme 切分，不能按 code unit——否则 emoji / 组合字符会被切坏 */
  function graphemes(text) {
    const s = String(text == null ? '' : text);
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
        return Array.from(seg.segment(s), (x) => x.segment);
      }
    } catch (_) {}
    return Array.from(s);
  }

  /* ---------------- 基础 step ---------------- */

  function insertStep(text) {
    return [{ method: 'Input.insertText', params: { text: text } }];
  }

  function charSteps(ch) {
    const info = keyInfo(ch);
    const modifiers = info.shift ? SHIFT : 0;
    return [
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: ch,
          code: info.code,
          text: ch,
          unmodifiedText: ch,
          windowsVirtualKeyCode: info.vk,
          nativeVirtualKeyCode: info.vk,
          modifiers: modifiers
        }
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key: ch,
          code: info.code,
          windowsVirtualKeyCode: info.vk,
          nativeVirtualKeyCode: info.vk,
          modifiers: modifiers
        }
      }
    ];
  }

  /* 换行：Shift+Enter。绝不发裸 Enter——那是聊天框的「发送」。 */
  function enterSteps() {
    return [
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: SHIFT
        }
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: SHIFT
        }
      }
    ];
  }

  /* ---------------- 整段写入 ---------------- */

  function planInsert(text) {
    const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (!s) return [];

    /* 空行陷阱（v2 已实测）：contenteditable 里整段写入会把 \n\n 变成三行。
     * 遇到空行就改成逐行写入 + 行间 Shift+Enter。 */
    if (/\n[ \t]*\n/.test(s)) {
      const steps = [];
      s.split('\n').forEach((line, i) => {
        if (i > 0) steps.push(...enterSteps());
        if (line) steps.push(...insertStep(line));
      });
      return steps;
    }

    return insertStep(s);
  }

  /* ---------------- 逐字模拟 ---------------- */

  function planKeys(text, opts) {
    const o = opts || {};
    const maxChars = Math.max(1, o.maxChars || 2000);
    const tabAsSpaces = o.tabAsSpaces == null ? 2 : Math.max(0, o.tabAsSpaces);

    let s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    let truncated = false;
    if (s.length > maxChars) {
      s = s.slice(0, maxChars);
      truncated = true;
    }

    const steps = [];
    let pending = '';
    const flush = () => {
      if (pending) {
        steps.push(...insertStep(pending));
        pending = '';
      }
    };

    for (const g of graphemes(s)) {
      if (g === '\n' || g === '\r') {
        flush();
        steps.push(...enterSteps());
        continue;
      }
      if (g === '\t') {
        flush();
        steps.push(...insertStep(tabAsSpaces > 0 ? ' '.repeat(tabAsSpaces) : '\t'));
        continue;
      }
      if (keyInfo(g)) {
        flush();
        steps.push(...charSteps(g));
      } else {
        // 中文 / emoji / 未覆盖的符号：攒起来走 insertText
        pending += g;
      }
    }
    flush();

    return {
      steps: steps,
      meta: {
        chars: s.length,
        truncated: truncated,
        keyEvents: steps.filter((x) => x.method === 'Input.dispatchKeyEvent').length,
        inserts: steps.filter((x) => x.method === 'Input.insertText').length
      }
    };
  }

  /* ---------------- 对外入口 ---------------- */

  function planTyping(text, opts) {
    const o = opts || {};
    const mode = o.mode || 'auto';
    const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    const lines = s ? s.split('\n').length : 0;
    const g = graphemes(s).length;

    if (mode === 'insert') {
      return {
        mode: 'insert',
        steps: planInsert(s),
        fallback: null,
        meta: { chars: s.length, lines: lines, graphemes: g, truncated: false }
      };
    }

    if (mode === 'keys') {
      const k = planKeys(s, o);
      return {
        mode: 'keys',
        steps: k.steps,
        fallback: null,
        meta: { chars: s.length, lines: lines, graphemes: g, truncated: k.meta.truncated }
      };
    }

    // auto：先整段，整段没效果再逐字
    const k = planKeys(s, o);
    return {
      mode: 'insert',
      steps: planInsert(s),
      fallback: k.steps,
      meta: { chars: s.length, lines: lines, graphemes: g, truncated: k.meta.truncated }
    };
  }

  const PBType = { planTyping, planInsert, planKeys, keyInfo, graphemes, SHIFT };

  if (typeof globalThis !== 'undefined') globalThis.PBType = PBType;
  if (typeof module !== 'undefined' && module.exports) module.exports = PBType;
})();
