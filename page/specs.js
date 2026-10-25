/* 贴进去 · PasteBridge — 编辑器适配器注册表
 *
 * 这里是「能插哪些框」的唯一答案。识别顺序很重要：先专用容器、后通用控件。
 * Monaco / Ace / CodeMirror / 各种富文本编辑器内部都藏了一个 textarea 或
 * contenteditable，必须先命中容器，再靠 detect 的「嵌套去重」把内部控件剔掉。
 *
 * cat 决定三件事：打分权重、多行策略、以及要不要包 Markdown 代码块。
 *   code  —— 代码编辑器，换行原样保留
 *   rich  —— 富文本 / 聊天框，换行要变成 <br> 而不是新段落
 *   plain —— 原生 textarea / input
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});

  const SPECS = [
    /* ---- 代码编辑器 ---- */
    { kind: 'cm6', sel: '.cm-editor', label: 'CodeMirror 6', cat: 'code' },
    { kind: 'cm5', sel: '.CodeMirror', label: 'CodeMirror 5', cat: 'code' },
    { kind: 'monaco', sel: '.monaco-editor', label: 'Monaco', cat: 'code' },
    { kind: 'ace', sel: '.ace_editor', label: 'Ace', cat: 'code' },

    /* ---- 富文本 / 聊天框 ----
     * 这些框架的 DOM 结构各不相同，但插入策略一致：
     * 先整段 execCommand（触发可信 beforeinput，框架当成真人输入），
     * 多行失败再逐行 insertLineBreak。 */
    { kind: 'pm', sel: '.ProseMirror', label: 'ProseMirror', cat: 'rich' },
    { kind: 'lexical', sel: '[data-lexical-editor="true"]', label: 'Lexical', cat: 'rich' },
    { kind: 'slate', sel: '[data-slate-editor="true"]', label: 'Slate', cat: 'rich' },
    { kind: 'draft', sel: '.public-DraftEditor-content', label: 'Draft.js', cat: 'rich' },
    { kind: 'quill', sel: '.ql-editor', label: 'Quill', cat: 'rich' },
    { kind: 'ck5', sel: '.ck-editor__editable', label: 'CKEditor 5', cat: 'rich' },
    { kind: 'tinymce', sel: 'body#tinymce, .mce-content-body', label: 'TinyMCE', cat: 'rich' },

    /* ---- 通用控件 ---- */
    {
      kind: 'ce',
      sel: '[contenteditable="true"],[contenteditable=""],[role="textbox"]',
      label: '富文本',
      cat: 'rich'
    },
    { kind: 'textarea', sel: 'textarea', label: '文本框', cat: 'plain' },
    {
      kind: 'input',
      sel: 'input[type="text"],input[type="search"],input[type="url"],input:not([type])',
      label: '输入框',
      cat: 'plain',
      /* 单行框遍地都是（站点搜索框、筛选框），只在聚焦或无其他候选时才参与 */
      lowPriority: true
    }
  ];

  const BY_KIND = Object.create(null);
  for (const s of SPECS) BY_KIND[s.kind] = s;

  /* 打分权重：代码编辑器 > 富文本 > 原生控件 */
  const CAT_WEIGHT = { code: 60, rich: 30, plain: 0 };

  /* 记录「最近聚焦过的编辑器」用的合并选择器 */
  const FOCUS_SEL = SPECS.map((s) => s.sel).join(',');

  function specOf(kind) {
    return BY_KIND[kind] || null;
  }

  function isLowPriority(kind) {
    const s = BY_KIND[kind];
    return !!(s && s.lowPriority);
  }

  NS.specs = { SPECS, CAT_WEIGHT, FOCUS_SEL, specOf, isLowPriority };
})();
