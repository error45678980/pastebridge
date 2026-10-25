# Store listing · English

> **先读这段，否则会白填。**
>
> Partner Center 的「语言行」是从 zip 包里读出来的。当前包**没有** `_locales` 目录，
> 所以只会出现**一个**语言行 —— 通常标成 English (United States)。
>
> 这时候你有两个选择：
>
> **选择 A（推荐，省事）**：那唯一的一行直接填中文文案（`listing-zh.md`）。
> 商店界面会显示成 "English (United States)"，但内容是中文。能过审，也不影响使用，
> 只是看起来有点怪。绝大多数中文小工具都这么干。
>
> **选择 B（正式，多花 20 分钟）**：给包加上 i18n，解锁中英两行。做法见文末。
>
> 下面的英文文案是给选择 B 用的，也是给未来上 Chrome Web Store 备着的。

---

## Extension name

`PasteBridge`

> 同样来自 manifest，只读。如果做了 i18n，`_locales/en/messages.json` 里可以写 `PasteBridge`，
> `_locales/zh_CN/messages.json` 里写 `贴进去 · PasteBridge`。

---

## Short description

```
Insert code straight into editors that block pasting — CodeMirror, Monaco, Ace and more.
```

---

## Detailed description

```
When Ctrl+V does nothing

Many online editors swallow the paste event. You press Ctrl+V, nothing happens, and you end up retyping the code line by line. Sometimes it is the editor's own policy; sometimes the site calls preventDefault during the capture phase.

PasteBridge takes a different route: instead of simulating a paste, it calls the editor's own insertion API and writes the text in directly. Since 2.0 it is also a local clipboard hub.

■ How to use

1. Click once inside the target editor so the caret lands there (optional, but more accurate)
2. Click the toolbar icon and paste your content into the popup
3. Click "Insert", or press Ctrl+Enter

The result is reported in a toast at the bottom-right of the page. The popup usually closes itself, because inserting moves focus back to the page — that is expected.

■ What it can insert into (14 kinds)

Code editors
· CodeMirror 5 / 6 — replaceSelection() / view.dispatch(), undo stack preserved
· Monaco — executeEdits() when a global monaco is present, hidden textarea otherwise
· Ace — editor.insert()

Chat boxes and rich text
· ProseMirror (ChatGPT, Claude, Feishu and more)
· Lexical, Slate, Draft.js
· Quill (Gemini, Zhihu and more)
· CKEditor 5, TinyMCE
· Any contenteditable

Native controls
· textarea
· single-line input

Editors inside iframes work too: all subframes are scanned, and you pick when more than one is available.

■ Use it as a clipboard

· History — everything you copied, captured or inserted, searchable and pinnable
· Snippets — save reusable code blocks, prompts or phrases with a name, language and tags
· Workbench — a full-page view with full-text search, filters, bulk cleanup and JSON export/import
· Capture selection — select text on any page and press Alt+Shift+S (no extra permission needed)
· Read clipboard — one click to pull the system clipboard in
· Context menu — right-click selected text, a link or the page to save it
· Shortcuts — Alt+Shift+V open panel, Alt+Shift+S capture selection, Alt+Shift+I insert the latest item

■ When nothing else works

Two fallbacks when every regular method fails:

· Blind insert — no extra permission needed. If the extension cannot recognise the target but you have already placed the caret in it, the text goes straight to the current focus. Editors inside closed shadow DOM work too.
· Keyboard simulation — the optional last resort. It writes the whole string first, then falls back to per-character keystrokes for terminals and canvas-based editors that only listen to keydown.

Keyboard simulation requires enabling a debugger permission; while attached, an "is debugging this browser" infobar appears briefly and disappears as soon as typing finishes. Not enabling it does not affect anything else.

Two rules are hard-coded: line breaks are always Shift+Enter (never a bare Enter, which would send a chat message), and Tab is always replaced with spaces (so focus never leaves the editor).

■ Accurate, never doubled

Every insertion is read back and verified. If the text changed but does not match what was sent, the extension stops immediately instead of retrying — no double insertion, ever.

Line breaks are preserved faithfully: rich text targets switch to line-by-line insertion when blank lines are present, so you never get extra empty lines. And because insertion uses editing commands rather than synthetic keystrokes, it never triggers a chat box's "send on Enter".

■ Multiple editors on one page

A code pane plus a test-case pane, or a three-column online IDE, is the common case. The extension resolves the target in this order: caret position → last choice for that site → single candidate → clearly leading score. When it still cannot decide, it paints numbered badges on each candidate: click one to choose, Esc to cancel, and the choice is remembered per site.

■ Nothing gets lost

· Drafts are saved automatically — closing the popup does not lose your text
· Insertion records are written by the background worker, so they survive the popup closing
· The header shows what the extension detected on the current page; click it to re-scan (and to force a scan of iframes)

■ Privacy

· No permission warning at install: only scripting, activeTab, storage and contextMenus
· No host_permissions, no persistent content scripts — nothing is read until you click the icon
· Clipboard reading and keyboard simulation are both optional permissions, requested only when you enable them
· All data stays in local browser storage; no upload, no network, no analytics
· No remote code — every line ships inside the package

■ Known limitations

· Closed shadow DOM can be blind-inserted, but the value cannot be read back, so the result is reported as unverified
· Keyboard simulation needs an optional debugger permission and fails when DevTools is open on the target tab
· Per-character simulation is slow for long text (2,000 characters by default)
· Cross-origin iframes require enabling one optional permission
· Read-only editors are detected and skipped
· chrome:// pages, extension stores and the PDF viewer do not allow injection at all
· Text over 20,000 characters is inserted in chunks and may leave several undo entries
· Single-line inputs cannot hold line breaks; they are converted to spaces (and the toast says so)
· Unknown editors fall back to the contenteditable path, which usually inserts plain text only

■ Who it is for

Solving algorithm problems, taking notes online, editing code in a browser IDE, pasting long code into an AI chat box — anywhere a "paste disabled" rule or constant window switching gets in the way.
```

---

## Search terms

Limit: **7 terms, 30 characters each, 21 words total**.

```
paste disabled
code editor
insert code
CodeMirror
Monaco
Ace editor
clipboard
```

---

## Category

`Developer tools`

---

## 附：给包加 i18n（选择 B 的做法）

**1. 建两个语言文件**

`_locales/en/messages.json`
```json
{
  "extName": { "message": "PasteBridge" },
  "extDesc": { "message": "Insert code straight into editors that block pasting." }
}
```

`_locales/zh_CN/messages.json`
```json
{
  "extName": { "message": "贴进去 · PasteBridge" },
  "extDesc": { "message": "在禁用粘贴的代码编辑器里，把代码直接插入 CodeMirror / Monaco / Ace。" }
}
```

**2. 改 manifest**

```json
"default_locale": "en",
"name": "__MSG_extName__",
"description": "__MSG_extDesc__"
```

**3. 重新打包**

```bash
python store/build-package.py
```

> 注意：`build-package.py` 的 `ITEMS` 列表里目前没有 `_locales`，
> 加完目录后要把它补进去，否则语言文件不会进包：
> ```python
> ("_locales", "_locales"),
> ```

做完这一步，Partner Center 里就会出现 `English (United States)` 和
`Chinese (Simplified)` 两行，各自传 logo、各自填文案。
