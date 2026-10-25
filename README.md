# 贴进去 · PasteBridge

把代码和文本送进**任何**输入框——代码编辑器、聊天框、富文本框都行；顺便当剪贴板用。

有些在线编辑器禁用了粘贴：`paste` 事件被 `preventDefault` 拦掉，Ctrl+V 毫无反应。  
这个扩展换了一条路：**不走粘贴，走「插入文本」**，把内容直接送进编辑器。  
v2 起它还是一个剪贴板中转站：复制过的内容、常用的代码片段，都能存下来一键回填或插入。

支持 Edge / Chrome（Chromium 102+），MV3，零运行时依赖，无构建步骤。

---

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载解压缩的扩展」，选择本目录（含 `manifest.json` 的那一层）
4. 建议把它固定到工具栏

**安装时零权限警告**：只申请 `scripting` + `activeTab` + `storage` + `contextMenus`。  
没有 `host_permissions`，没有常驻内容脚本，不读取任何页面数据。  
剪贴板读取是**可选权限**，只有你主动点「读剪贴板」时才会申请。

## 用法

### 插入

1. （可选但更准）先在页面里点一下目标编辑器，让光标落到里面
2. 点扩展图标 → 把内容粘进弹窗 → 点「插入」（或 `Ctrl+Enter`）
3. 结果看**页面右下角的提示**——插入时页面会抢走焦点，弹窗通常会自己关掉

### 当剪贴板用

| 想做什么        | 怎么做                                      |
| ----------- | ---------------------------------------- |
| 把系统剪贴板内容读进来 | 弹窗里点「读剪贴板」（首次会申请权限）                      |
| 翻历史，一键回填    | 弹窗点「历史」；或打开**工作台**搜索                     |
| 存常用代码块      | 工作台 →「＋ 新建片段」，可命名、加语言和标签                 |
| 抓页面上的选中文本   | 弹窗/工作台点「抓取选区」，或 `Alt+Shift+S`（**零额外权限**） |
| 右键保存        | 选中文字/链接/页面右键 →「保存到贴进去」                   |
| 把最近一条插回去    | 输入框里右键 →「把最近一条内容插入这里」，或 `Alt+Shift+I`    |

快捷键：`Alt+Shift+V` 打开面板 · `Alt+Shift+S` 存选区 · `Alt+Shift+I` 插入最近一条。

## 支持的框（14 类）

| 类别     | 编辑器                | 识别依据                                            |
| ------ | ------------------ | ----------------------------------------------- |
| 代码     | CodeMirror 6 / 5   | `.cm-editor` / `.CodeMirror`                    |
| 代码     | Monaco / Ace       | `.monaco-editor` / `.ace_editor`                |
| 聊天/富文本 | ProseMirror        | `.ProseMirror`（ChatGPT、Claude、飞书等）              |
| 聊天/富文本 | Lexical            | `[data-lexical-editor="true"]`                  |
| 聊天/富文本 | Slate              | `[data-slate-editor="true"]`                    |
| 聊天/富文本 | Draft.js           | `.public-DraftEditor-content`                   |
| 聊天/富文本 | Quill              | `.ql-editor`（Gemini、知乎等）                        |
| 聊天/富文本 | CKEditor 5         | `.ck-editor__editable`                          |
| 聊天/富文本 | TinyMCE            | `body#tinymce` / `.mce-content-body`            |
| 通用     | 任意 contenteditable | `[contenteditable="true"]` / `[role="textbox"]` |
| 通用     | 多行文本框              | `textarea`                                      |
| 通用     | 单行输入框              | `input[type=text/search/url]`                   |

单行输入框遍地都是（站点搜索框），所以它只在**已聚焦**或页面上没有别的候选时才参与选择。

## 插不进去的时候：盲插与键盘模拟

常规方法全失败时，v2.1 还有两级后手。它们的目标不是「更准」，而是**别让用户只能手敲**。

### 盲插（零权限）

扩展认不出目标、但你已经把光标点进去了——这时它直接把文字打到**当前焦点**，  
不需要任何额外权限。`document.execCommand('insertText')` 作用于文档焦点，  
不受 shadow 边界限制，所以 **closed shadow DOM 里的编辑器也能打进去**（已实测）。

代价是「看不见」：closed shadow 里读不到元素引用，就没法回读校验。  
所以结果分三态，绝不把不确定说成成功：

| 状态          | 含义            | 界面表现           |
| ----------- | ------------- | -------------- |
| `strict`    | 目标可读，前后比对确实变了 | ✓ 已盲插          |
| `uncertain` | 命令执行了，但读不到值   | 已尝试盲插（未校验），请检查 |
| `none`      | 命令失败或没变化      | 转键盘模拟          |

### 键盘模拟（仅增强版）

浏览器不允许网页脚本伪造真实按键（`isTrusted: false` 的键盘事件不产生文本），  
所以「像人一样打字」只能走 CDP。扩展的做法是：

```
附加调试器 → Input.insertText 整段写入
           → 没效果则 Input.dispatchKeyEvent 逐字
           → 立即断开
```

**这里有一个 Chrome 的硬限制**：`debugger` **不能作为可选权限在运行时申请**。  
写进 `optional_permissions` 会被静默丢弃，`chrome.permissions.request` 必定抛  
`Only permissions specified in the manifest may be requested`。  
所以想用它，只能把它放进必需的 `permissions`——代价是安装时多一条警告。

因此提供两个安装包：

| 版本      | 权限             | 键盘模拟        | 适合              |
| ------- | -------------- | ----------- | --------------- |
| **标准版** | 零警告            | 不可用（盲插仍然可用） | 大多数场景           |
| **增强版** | 多一条「访问页面调试器后端」 | 可用          | 需要对付终端 / 画布类编辑器 |

两条铁律写死在计划器里：

- **换行只发 Shift+Enter**，绝不发裸 Enter——否则聊天框会直接发送。
- **Tab 绝不发 VK 9**，那会把焦点移出编辑器；一律替换成空格。

逐字模式下中文与 emoji 不走按键（没有对应键码），攒起来走 `insertText`，  
并按 grapheme 切分以免切坏代理对。上限默认 2000 字符，超出会截断并提示。

使用时浏览器顶部会短暂出现「正在调试此浏览器」，断开即消失。  
目标标签页开着开发者工具时会失败，少数反爬站点会拒绝服务。

## 剪贴板能力

- **历史**：复制过的内容、抓取的选区、插入过的文本都会留档；可搜索、置顶、一键复制或插入。
- **片段库**：手动收藏的代码块 / 提示词 / 话术，带名称、语言、标签和使用次数。
- **工作台**：独立全页界面（弹窗 →「工作台」），支持全文搜索、筛选、批量清理、导入导出 JSON。
- **容量**：索引与正文分键存放，默认保留 50 条；超过 8MB 自动淘汰最旧的非置顶项，置顶永不淘汰。

数据全部存在 `chrome.storage.local`，不上传、不联网。

## 权限

| 权限                                               | 何时生效      | 用途                   |
| ------------------------------------------------ | --------- | -------------------- |
| `scripting` `activeTab` `storage` `contextMenus` | 安装即有      | 注入、临时页面访问、本地存储、右键菜单  |
| `clipboardRead` `clipboardWrite`（可选）             | 你点「读剪贴板」时 | 读取 / 写回系统剪贴板         |
| `debugger`（仅增强版，必需）                              | 安装即授予     | 附加调试器模拟键入，用完立即断开     |
| `*://*/*`（可选 host）                               | 你主动开启时    | 访问跨域 iframe、后台记录复制内容 |

> `debugger` 无法做成可选权限（Chrome 会丢弃），详见上一节。标准版不含它，安装零警告。

安装时不会弹任何权限警告。可选权限只能在用户点击的同一个任务里申请，  
所以授权入口统一放在工作台的「设置」里——在弹窗里弹授权框会把弹窗关掉。

## 四个关键设计

**1. 必须注入主世界（MAIN world）**  
`el.CodeMirror`、`el.env.editor`、`cmTile.view` 这类实例是页面脚本挂在 DOM 上的自定义属性，  
隔离世界读不到。所以用 `chrome.scripting.executeScript({ world: 'MAIN' })` 注入；  
少数站点拒绝主世界注入时自动降级到隔离世界——原生 API 失效，但 `execCommand` 仍然可用。

**2. 不合成 `paste` 事件**  
合成 `ClipboardEvent('paste')` 行不通：网站拦的正是 `paste`，你合成的事件照样被 `preventDefault`。  
`execCommand('insertText')` 是浏览器级编辑命令，不经过 paste 事件，而且它触发的是**可信**的  
`beforeinput`/`input`——ProseMirror、Lexical、Slate、Draft 都会当成真人输入。

**3. 方法阶梯 + 回读校验**  
每种编辑器都有一条降级链：  
`原生实例 API → 整段 execCommand → 逐行 insertLineBreak → beforeinput+DataTransfer → Range 兜底`。  
每次插入后回读比对；只有「完全没产生变化」才升级到下一个方法，  
内容变了但对不上就立即停手，**绝不插第二遍**。

**4. 换行要保真**  
v1 的校验会把所有空白抹掉再比对，于是「换行全丢、代码挤成一行」也会被判成功——这是个长期漏检的坑。  
v2 加了**行数结构校验**，并且发现：contenteditable 里一个空行需要两个 `<br>` 才撑得开，  
整段 `insertText` 会把 `\n\n` 变成 `\n\n\n`（多一个空行），而**逐行 `insertLineBreak` 是精确的**。  
所以富文本框遇到空行时，逐行优先。

另外：`insertLineBreak` 不触发 `keydown`，所以插多行代码**绝不会误触聊天框的「回车发送」**。

## iframe

v1 完全不支持 iframe。v2 用双通道：

1. `executeScript({ allFrames: true })` 一次覆盖所有能进的帧；
2. 整体失败就退回只注顶层；
3. 逐帧扫描候选并带上 `frameId`，顶层候选加 30 分；
4. 插入时只把目标帧 id 传下去。

跨域子帧需要额外授权：在设置里开启 host 权限后即可访问（同 host 不同端口也算跨域）。  
多个帧都有候选时，弹窗会列出「主页面 / 内嵌框架 N」让你选。

## 已知限制

- **closed shadow DOM**：能盲插，但读不到值，只能报「未校验」
- **只读编辑器**：会被识别出来并跳过
- **受限页面**：`chrome://`、扩展商店、PDF 阅读器不允许扩展注入
- **跨域 iframe**：需要手动开启 host 权限
- **键盘模拟**：仅增强版可用（标准版不含 `debugger`）；目标标签页开着开发者工具时会失败；逐字模式对长文本较慢
- **自研编辑器**：不在上表里的会退化成 contenteditable 路径，通常只能插纯文本
- **超长文本**：超过 2 万字符会分段插入，可能在编辑器里留下多个撤销节点
- **单行输入框**：换行会被转成空格（并在提示里说明）
- **演示页里的富文本**：`demo/rich.html` 是按各框架 DOM 契约构造的夹具，不是真实库；  
  真实站点的差异靠线上使用验证

## 开发

```bash
npm install          # 只为跑测试，扩展本身零依赖

npm run icons        # 重新生成 16/32/48/128 图标（纯 Python 标准库）
npm run demo         # 起本地演示页 http://localhost:8080
npm run pack         # 打标准版包（零权限警告）
npm run pack:debugger # 打增强版包（内置 debugger，可用键盘模拟）
npm run test:store   # 存储层：迁移 / 去重 / 淘汰 / 导入导出（31 项）
npm run test:typing  # 键入计划器：Shift+Enter / Tab / emoji / 截断（23 项）
npm test             # 插入逻辑：代码编辑器 + 富文本 + 聊天框 + 盲插（63 项）
npm run test:ext     # 真实扩展环境：双世界 + iframe + CDP 键入 + 工作台（49 项）
npm run test:all     # 四套一起跑
```

- `npm test` 把 `page/*.js` 直接注入演示页，绕开扩展 UI，只测最容易翻车的插入逻辑。
- `npm run test:typing` 不启动浏览器——它断言的是 CDP 命令序列本身，  
  比如「换行必须是 `modifiers:8`」「Tab 一条都不许发」「emoji 不能被切碎」。
- `npm run test:ext` 会真的把扩展装进 Chromium（测试时复制一份并临时加上  
  `127.0.0.1` 的 host 权限与 `debugger` 权限），验证 MAIN / ISOLATED 两条通道、  
  跨域 iframe 定向插入、CDP 整段与逐字键入、工作台渲染。
- 演示页 `demo/index.html` 挂载五种代码编辑器，并且**每个都注册了 capture 阶段的 paste 拦截**来模拟真实站点。  
  它依赖 CDN（unpkg → BootCDN → npmmirror 自动降级）；CDN 不通时扩展测试会跳过该场地而不判失败。
- `demo/rich.html`、`demo/chat.html`、`demo/frames.html`、`demo/closed.html`、`demo/keys.html`  
  都是**纯离线**夹具，测试确定性有保障。

## 目录

```
manifest.json          MV3 声明
background/sw.js       背景编排：注入 / 扫描 / 插入 / 键入 / 右键菜单 / 快捷键 / 迁移
lib/
  files.js             注入清单（单一来源）
  store.js             剪贴板存储：索引、片段、迁移、配额淘汰
  typing.js            键入计划器（纯函数：文本 → CDP 命令序列）
  cdp.js               调试器传输层：attach / send / detach / 串行锁
page/                  页面世界（不依赖任何扩展 API，两个世界都能跑）
  core.js              命名空间、CSP 安全的 toast、跨 shadow 查询
  specs.js             14 类编辑器适配器注册表
  detect.js            候选收集、打分、嵌套去重、只读探测
  methods.js           各编辑器的插入方法阶梯
  insert.js            插入驱动、回读、结构校验、失败分类
  picker.js            多编辑器编号徽章与点选
  main.js              window.__WB__ 门面（precheck / scan / grab / blind / probe / focus / insert）
popup/                 弹窗：输入、插入、历史、片段、兜底键入、工作台入口
workbench/             全页工作台：历史 / 片段 / 设置
demo/                  代码编辑器、富文本、聊天框、iframe、closed shadow、keydown-only 六套夹具
tests/                 端到端与单元测试
tools/make-icons.py    程序化生成图标
```

## 一点实现细节

页面世界的 UI 全部用 CSSOM 属性赋值（`el.style.xxx = ...`），不用 `innerHTML`、不写 `style` 属性字符串。  
因为 GitHub 这类站点开着 Trusted Types 和严格 CSP，用字符串写 HTML 会直接抛异常。  
`requestAnimationFrame` 也带了定时兜底——后台标签页里它会被节流，不兜底会把插入流程卡死。

## License

[MIT](LICENSE) © error45678980
