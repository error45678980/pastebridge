# 贴进去 · PasteBridge

有些在线代码编辑器禁用了粘贴——`paste` 事件被 `preventDefault` 拦掉，Ctrl+V 毫无反应。
这个扩展换了一条路：**不走粘贴，走「插入文本」**，把代码直接送进编辑器。

支持 Edge / Chrome（Chromium 102+），MV3，零运行时依赖。

---

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载解压缩的扩展」，选择本目录（含 `manifest.json` 的那一层）
4. 建议把它固定到工具栏

**权限说明**：只申请了 `scripting` + `activeTab` + `storage`，没有 `host_permissions`、没有常驻内容脚本、不读取任何页面数据。
只有你点图标的那一刻，扩展才拿到当前标签页的临时授权。

## 用法

1. （可选但更准）先在页面里点一下目标编辑器，让光标落到里面
2. 点扩展图标 → 把代码粘进弹窗 → 点「插入」（或 `Ctrl+Enter`）
3. 结果看**页面右下角的提示**——插入时页面会抢走焦点，弹窗通常会自己关掉

弹窗里还带了：草稿自动保存（误关不丢）、最近 10 段插入历史、当前页面编辑器识别状态。

## 支持范围

| 编辑器 | 识别依据 | 插入方式 |
| --- | --- | --- |
| CodeMirror 5 | `.CodeMirror` | `cm.replaceSelection()`，兜底 `execCommand` |
| CodeMirror 6 | `.cm-editor` | `view.dispatch()`，兜底 `execCommand` |
| Monaco | `.monaco-editor` | `executeEdits()`（有全局 `monaco` 时），否则隐藏 `textarea` + `execCommand` |
| Ace | `.ace_editor` | `editor.insert()`，兜底 `execCommand` |
| 普通输入框 | `textarea` | `execCommand`（保留原生撤销栈），超长文本走 `setRangeText` |
| 富文本框 | `[contenteditable]` | `execCommand`，兜底 Range + `InputEvent` |

实测覆盖：五种编辑器 × {单行, 50 行多行, Tab 缩进, 10 万字符}，以及「拿不到原生 API」的降级路径。

## 三个关键设计

**1. 必须注入主世界（MAIN world）**
`el.CodeMirror`、`el.env.editor` 这类实例是页面脚本挂在 DOM 上的自定义属性，内容脚本的隔离世界读不到。
所以扩展用 `chrome.scripting.executeScript({ world: 'MAIN' })` 注入。少数站点会拒绝主世界注入，此时自动降级到隔离世界——原生 API 通道失效，但 `execCommand` 仍然可用（已实测六种编辑器全部通过）。

**2. 不合成 `paste` 事件**
合成 `ClipboardEvent('paste')` 是行不通的：网站拦的正是 `paste`，你合成的事件照样会被 `preventDefault`。
`execCommand('insertText')` 是浏览器级编辑命令，根本不经过 paste 事件，这才是绕过去的正解。

**3. 每次插入都回读校验**
插完立刻把编辑器里的文本读回来比对：
- **严格校验**：文本里确实出现了要插的代码
- **弱校验**：只匹配到尾部，或文档长度增长量对得上（虚拟化渲染的编辑器可能还没画进 DOM）
- **没变化**：才升级到下一个方法；**内容变了但不匹配就立即停手**，绝不重试，避免插两遍

## 多编辑器

一个页面上有多个编辑器时（LeetCode 的代码区+测试用例区、CodePen 的三栏），按下面的顺序定目标：

`显式指定` → `当前光标所在` → `该网站上次的选择` → `唯一候选` → `打分明显领先` → `页面内点选`

判定不了的时候，会在每个候选编辑器上画编号徽章，点一下选目标，`Esc` 取消，并按网站记住这次选择。

## 已知限制

- **iframe 里的编辑器**：v1 不支持（activeTab 只覆盖顶层文档）。页面有 iframe 又找不到编辑器时会明确提示
- **closed shadow DOM**：穿透不了（open shadow root 是支持的）
- **只读编辑器**：会被识别出来并跳过
- **受限页面**：`chrome://`、扩展商店、PDF 阅读器不允许扩展注入
- **自研编辑器**：不在上表里的编辑器会退化成 contenteditable 路径，通常只能插纯文本
- **超长文本**：超过 2 万字符会分段插入，可能在编辑器里留下多个撤销节点

## 开发

```bash
npm install        # 只为跑测试，扩展本身零依赖

npm run icons      # 重新生成 16/32/48/128 图标（纯 Python 标准库，无需 Pillow）
npm run demo       # 起本地演示页 http://localhost:8080
npm test           # 核心插入逻辑：5 编辑器 × 4 文本形态 + 降级 + 点选（28 项）
npm run test:ext   # 真实扩展环境：MAIN/ISOLATED 双通道 + 弹窗全链路（19 项）
```

`npm test` 会把 `page/*.js` 直接注入演示页，绕开扩展 UI，只测最容易翻车的插入逻辑。
`npm run test:ext` 会真的把扩展装进 Chromium（测试时复制一份并临时加上 `127.0.0.1` 的 host 权限），
分别验证主世界与隔离世界两条通道。

演示页 `demo/index.html` 同时挂载五种编辑器，并且**每个都注册了 capture 阶段的 paste 拦截**来模拟真实站点——
你可以先按 Ctrl+V 看它被拦下（计数器 +1），再用扩展插入。它依赖 CDN（unpkg → BootCDN → npmmirror 自动降级），需要联网。

## 目录

```
manifest.json          MV3 声明，无 host_permissions
popup/                 弹窗：预检、插入、草稿、历史
page/                  页面世界（不依赖任何扩展 API，两个世界都能跑）
  core.js              命名空间、CSP 安全的 toast、跨 shadow 查询
  detect.js            候选收集、打分、嵌套去重、只读探测
  insert.js            六种适配器 + 校验阶梯
  picker.js            多编辑器编号徽章与点选
  main.js              window.__WB__ 门面
demo/                  五种编辑器 + 禁粘贴模拟
tests/                 Playwright 端到端
tools/make-icons.py    程序化生成图标
```

## 一点实现细节

页面世界的 UI 全部用 CSSOM 属性赋值（`el.style.xxx = ...`），不用 `innerHTML`、不写 `style` 属性字符串。
因为 GitHub 这类站点开着 Trusted Types 和严格 CSP，用字符串写 HTML 会直接抛异常。
`requestAnimationFrame` 也带了定时兜底——后台标签页里它会被节流，不兜底会把插入流程卡死。

## License

[MIT](LICENSE) © error45678980
