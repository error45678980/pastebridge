# 隐私政策 · Privacy Policy

> **这个文件需要变成一个网址，Partner Center 才肯收。** 三种做法，从省事到正式：
>
> **A. GitHub 页面直链（最快，5 秒）**
> 把本文件推到仓库后，用这个地址：
> `https://github.com/error45678980/pastebridge/blob/main/store/privacy-policy.md`
> 微软接受 GitHub 上的政策文件（很多开源扩展都这么干）。
>
> **B. GitHub Pages（更好看）**
> 仓库 → Settings → Pages → Source 选 `main` / `/docs`，
> 把本文件复制成 `docs/privacy.html` 或 `docs/privacy.md`，地址就是
> `https://error45678980.github.io/pastebridge/privacy.html`
>
> **C. 塞进你自己的站点**
> 有域名的话直接丢上去，最稳。
>
> 无论用哪种，提交前**在无痕窗口里打开确认能访问**，别用登录态才能看的地址。

---

## 中文

**生效日期：2026 年 10 月 25 日**

「贴进去 · PasteBridge」（以下简称「本扩展」）是一个浏览器扩展，用于把用户提供的文本插入当前网页的编辑器，并在本机管理剪贴板历史与常用片段。本政策说明本扩展如何处理数据。

### 一句话总结

**本扩展不收集、不传输、不出售任何用户数据。**

### 1. 我们不收集什么

本扩展不收集任何个人信息，包括但不限于：姓名、邮箱、账号、设备标识符、浏览历史、IP 地址、位置、使用统计、崩溃报告。

本扩展**不发起任何网络请求**。没有分析 SDK，没有遥测，没有第三方脚本。

### 2. 本地存储的数据

为了让功能可用，本扩展使用浏览器的 `chrome.storage.local` 在本机保存以下内容：

| 数据 | 用途 | 保存位置 | 是否上传 |
| --- | --- | --- | --- |
| 草稿（你正在弹窗里编辑的文本） | 弹窗被页面抢焦点关闭时不丢内容 | 本机浏览器存储 | 否 |
| 插入记录（默认最近 50 条） | 「历史」面板里一键回填 | 本机浏览器存储 | 否 |
| 剪贴板历史 | 你主动读取或抓取的文本，供搜索与回填 | 本机浏览器存储 | 否 |
| 片段库 | 你手动保存的常用代码块、提示词、话术 | 本机浏览器存储 | 否 |
| 站点偏好 | 记住你在某个网站选择的编辑器 | 本机浏览器存储 | 否 |

这些数据**始终留在你的设备上**，开发者无法访问。卸载扩展时，浏览器会一并清除。

### 2.1 剪贴板数据

本扩展**不会在后台自动记录你复制的所有内容**。内容进入剪贴板历史只有三种途径，且都需要你的明确操作：

1. 你点击「读剪贴板」——此时才会申请 `clipboardRead` 可选权限；
2. 你点击「抓取选区」或按 `Alt+Shift+S`——只读取当前页面上你**选中**的那段文本；
3. 你通过右键菜单主动保存选中的文本、链接或页面标题。

剪贴板内容只写入本机 `chrome.storage.local`，用于在你自己设备上检索与回填。
它不会被上传、分析、共享，也不会用于任何形式的用户画像。
你可以随时在工作台里逐条删除，或一次性清空（可选择保留置顶项）。

### 2.2 键盘模拟

当常规插入方式全部失败时，可以选择让扩展「模拟键盘输入」把文字打进去。
浏览器不允许网页脚本伪造真实按键，因此这条通道必须借助 Chrome 调试协议（CDP），
需要 `debugger` 权限。

**Chrome 不允许把 `debugger` 作为「可选权限」在运行时申请**（会直接报错），
所以本扩展提供两个安装包，由你自行选择：

| 版本 | 权限 | 键盘模拟 |
| --- | --- | --- |
| 标准版 | 不含 `debugger`，安装零警告 | 不可用（仍可用盲插处理检测不到的编辑器） |
| 增强版 | 内置 `debugger`，安装时多一条「访问页面调试器后端」警告 | 可用 |

增强版中该权限的行为：

- 只在一次键入操作期间附加（通常 1–3 秒），操作结束立即断开；
- 只发送 `Input.insertText` 与 `Input.dispatchKeyEvent` 两类命令，
  不读取页面内容、不拦截网络、不修改任何其他数据；
- 附加期间浏览器顶部会显示「正在调试此浏览器」提示条，断开后消失；
- 目标标签页开着开发者工具时会失败，这是 Chrome 的限制；
- 少数站点会检测调试器附加并拒绝服务。

不需要键盘模拟的话，安装标准版即可。

### 3. 页面访问

本扩展申请了 `activeTab` 权限，而非 `host_permissions`。这意味着：

- 在你点击工具栏图标**之前**，本扩展对任何网页都没有访问能力
- 只有你点击图标时，浏览器才临时授予当前标签页的访问权
- 切换标签页或关闭页面后，该授权立即失效

扩展注入的脚本只做四件事：在当前页面里找到编辑器、把文本插进去、读取你选中的那段文字、报告插入结果。
它不读取、不记录、不上传页面上的任何其他内容。

如果你在设置里**主动开启**了 host 权限（用于访问跨域 iframe），扩展才会获得对应站点的访问能力。
该权限可以随时在扩展详情页撤销，撤销后立即失效。

### 4. 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击图标或使用快捷键时获得当前标签页的临时访问权 |
| `scripting` | 把插入脚本注入当前标签页（需在主世界执行，才能访问编辑器实例） |
| `storage` | 在本机保存草稿、历史、片段与偏好 |
| `contextMenus` | 提供「保存到贴进去」等右键菜单项 |
| `clipboardRead` / `clipboardWrite`（可选） | 仅在你点击相关按钮时申请，用于读取或写回系统剪贴板 |
| `debugger`（仅增强版，必需） | 标准版不含此项；增强版安装时即授予，用于模拟键入，每次用完立即断开 |
| `host_permissions`（可选） | 仅在你主动开启时申请，用于访问跨域 iframe |

可选权限在安装时不会申请，也不会产生权限警告；只有你点击对应按钮时才会弹出一次授权询问。

### 5. 远程代码

本扩展不使用远程代码。所有逻辑都包含在安装包内，不加载远程脚本，不使用 `eval` 或 `new Function`。

### 6. 第三方

本扩展不集成任何第三方服务、广告网络或数据经纪商，也不向任何第三方共享数据。

### 7. 儿童隐私

本扩展不面向 13 岁以下儿童，也不会有意收集儿童信息（事实上它不收集任何人的信息）。

### 8. 政策变更

如果本政策发生实质变更，更新会发布在本页面，并同步更新上方的「生效日期」。

### 9. 联系方式

有问题请开 issue：
`https://github.com/error45678980/pastebridge/issues`

---

## English

**Effective date: October 25, 2026**

"PasteBridge" (the "Extension") is a browser extension that inserts user-provided text into the editor of the current web page, and manages clipboard history and snippets locally on your device. This policy explains how the Extension handles data.

### Summary

**The Extension does not collect, transmit, or sell any user data.**

### 1. What we do not collect

The Extension collects no personal information, including but not limited to: name, email, account identifiers, device identifiers, browsing history, IP address, location, usage analytics, or crash reports.

The Extension makes **no network requests whatsoever**. There is no analytics SDK, no telemetry, and no third-party script.

### 2. Data stored locally

To function, the Extension uses the browser's `chrome.storage.local` to store the following on your own device:

| Data | Purpose | Location | Transmitted |
| --- | --- | --- | --- |
| Draft (text you are editing in the popup) | Preserve input when the popup closes | Local browser storage | No |
| Insertion records (last 50 by default) | One-click refill from the History panel | Local browser storage | No |
| Clipboard history | Text you explicitly read or captured, for search and refill | Local browser storage | No |
| Snippet library | Code blocks, prompts or phrases you saved manually | Local browser storage | No |
| Site preference | Remembers which editor you picked on a given site | Local browser storage | No |

This data **never leaves your device** and is inaccessible to the developer. Uninstalling the Extension removes it.

### 2.1 Clipboard data

The Extension **does not record everything you copy in the background**. Content enters clipboard history only through three explicit actions:

1. You click "Read clipboard" — only then is the optional `clipboardRead` permission requested;
2. You click "Capture selection" or press `Alt+Shift+S` — only the text you have **selected** on the current page is read;
3. You use the context menu to save the selected text, a link, or the page title.

Clipboard content is written only to local `chrome.storage.local`, for retrieval and refill on your own device.
It is never uploaded, analyzed, shared, or used for profiling.
You can delete entries individually, or clear everything at once (optionally keeping pinned items).

### 2.2 Keyboard simulation

When every regular insertion method fails, you may choose to have the Extension "simulate typing" the text instead.
Browsers do not allow page scripts to forge real keystrokes, so this channel must use the Chrome DevTools Protocol (CDP)
and requires the `debugger` permission.

**Chrome does not allow `debugger` to be requested at runtime as an optional permission** (the request fails outright),
so the Extension ships in two builds:

| Build | Permission | Keyboard simulation |
| --- | --- | --- |
| Standard | no `debugger`; zero install warnings | unavailable (blind insert still works) |
| Enhanced | `debugger` built in; adds an "Access the page debugger backend" warning at install | available |

Behaviour of that permission in the Enhanced build:

- attached only for the duration of one typing operation (typically 1–3 seconds), detached immediately afterwards;
- used solely to send `Input.insertText` and `Input.dispatchKeyEvent` commands — the Extension does not read page
  content, intercept network traffic, or modify any other data;
- causes an "is debugging this browser" infobar to appear while attached; it disappears after detaching;
- fails when DevTools is open on the target tab — a Chrome limitation;
- may be detected by a small number of anti-bot sites.

If you do not need keyboard simulation, install the Standard build.

### 3. Page access

The Extension requests `activeTab` rather than `host_permissions`. This means:

- Before you click the toolbar icon, the Extension has **no access** to any web page
- Access to the current tab is granted only at the moment you click the icon
- The grant expires as soon as you switch tabs or close the page

The injected script does exactly four things: locate the editor on the page, insert text into it, read the text you have selected, and report the insertion result. It does not read, record, or transmit any other page content.

If you **explicitly enable** host permissions in Settings (to reach cross-origin iframes), the Extension gains access to those sites. That permission can be revoked at any time from the extension details page and takes effect immediately.

### 4. Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the current tab when you click the icon or use a shortcut |
| `scripting` | Inject the insertion script into the current tab (must run in the main world to reach editor instances) |
| `storage` | Save drafts, history, snippets and preferences locally |
| `contextMenus` | Provide "Save to PasteBridge" context menu items |
| `clipboardRead` / `clipboardWrite` (optional) | Requested only when you click the relevant buttons, to read or write the system clipboard |
| `debugger` (Enhanced build only, required) | Not present in the Standard build; granted at install in the Enhanced build, used for simulated typing and detached after each operation |
| `host_permissions` (optional) | Requested only when you explicitly enable it, to reach cross-origin iframes |

Optional permissions are not requested at install time and produce no install warning; the prompt appears only when you click the corresponding button.

### 5. Remote code

The Extension uses no remote code. All logic ships inside the package; no remote scripts, no `eval`, no `new Function`.

### 6. Third parties

No third-party services, ad networks, or data brokers are integrated, and no data is shared with any third party.

### 7. Children's privacy

The Extension is not directed to children under 13 and does not knowingly collect information from children (it collects no information from anyone).

### 8. Changes

Material changes to this policy will be published on this page with an updated effective date.

### 9. Contact

Please open an issue: `https://github.com/error45678980/pastebridge/issues`
