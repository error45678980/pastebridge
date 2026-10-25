# Partner Center 填表答案

> 提交页一共 8 步，真正会卡住审核的是 **Privacy** 和 **Notes for certification** 这两块。
> 下面按页面顺序给答案，能直接复制。

---

## 1. Availability（可用性）

| 字段 | 填什么 | 说明 |
| --- | --- | --- |
| Visibility | `Public` | 想先小范围试水就选 `Hidden`，只能通过列表直链安装，搜不到 |
| Markets | 全部市场（默认） | 中文文案已经覆盖主要市场，不用单独裁剪 |

---

## 2. Properties（属性）

| 字段 | 填什么 |
| --- | --- |
| Category | `Developer tools` |
| Website | `https://github.com/error45678980/pastebridge` |
| Support contact | `https://github.com/error45678980/pastebridge/issues` |
| Mature content | 否 |

---

## 3. Privacy（隐私）—— 审核重灾区

### 3.1 单一用途说明（Single purpose）

```
把用户提供的文本插入当前网页的代码编辑器（CodeMirror、Monaco、Ace、textarea、contenteditable），
作为「网站禁用粘贴」时的替代输入方式。
```

英文（如果界面是英文）：

```
Insert user-provided text into the code editor of the current web page (CodeMirror, Monaco, Ace,
textarea, contenteditable), as an alternative input path when the website blocks pasting.
```

> 要点：一句话、范围窄、和实际行为对得上。别写「提升编程效率」这种大词。

### 3.2 权限理由（Permission justification）

**`scripting`**

```
用于在用户点击工具栏图标后，把 page/ 目录下的脚本注入当前标签页。
注入必须使用 world: "MAIN"：CodeMirror / Monaco / Ace 的编辑器实例是页面脚本挂在 DOM 元素上的
自定义属性（el.CodeMirror、el.env.editor），扩展的隔离世界读不到这些属性，也就无法调用编辑器
自带的插入接口。注入只在用户点击图标后触发，不会在后台或页面加载时自动执行。
```

**`activeTab`**

```
用来替代 host_permissions，实现权限最小化。用户点击扩展图标时，浏览器才临时授予当前标签页的
访问权；切换标签页或关闭页面后自动失效。也就是说，用户不主动使用扩展时，扩展对任何网页都
没有任何访问能力。
```

**`storage`**

```
把用户正在编辑的草稿和最近 10 条插入记录保存在本地 chrome.storage.local。
因为插入时页面会抢走焦点、弹窗通常会自动关闭，没有草稿保存会直接丢失用户输入。
只写本地，不使用 storage.sync，不涉及任何上传。
```

### 3.3 远程代码（Remote code）

```
否。扩展不加载任何远程脚本，不使用 eval / new Function / 动态 import，
所有逻辑都在提交的 zip 包内。
```

> 演示页 demo/ 会从 CDN 拉 CodeMirror / Monaco / Ace 这些**第三方开源库**，
> 但它不在 zip 包里，和扩展运行时无关。如果审核员问起，按这句话回答。

### 3.4 数据使用（Data usage）

**九项全部不勾选**（不收集任何用户数据）。

如果有必填的补充说明，填：

```
扩展不收集、不传输任何用户数据。用户输入的草稿和插入历史仅保存在本地设备的
chrome.storage.local 中，不会离开浏览器，开发者无法访问。扩展不发起任何网络请求。
```

### 3.5 隐私政策 URL

必填。见 `privacy-policy.md` 顶部，那里写了怎么把这个文件变成一个可访问的网址。

---

## 4. Store listing（商店列表）

文案和素材都在隔壁：

- `listing-zh.md` —— 中文文案（描述、搜索词）
- `assets/` —— logo、截图、宣传图

每个语言都要传 **logo**；名称和简短描述**至少一个语言**要填（这两个来自 manifest，只读）。

---

## 5. Notes for certification（认证测试备注）

> 这段是「给审核员的操作手册」。写清楚了，通过率明显不一样。
> 直接整段复制进文本框。

```
这是一个开发者工具：当网页上的代码编辑器禁用了粘贴，用户可以点击扩展图标，
把文本直接插入编辑器。

【为什么必须先点击图标】
扩展没有 host_permissions，只申请了 activeTab。这是刻意的权限最小化设计：
在用户点击工具栏图标之前，扩展对任何网页都没有访问权限。
所以测试时请先点击图标，再观察效果 —— 这不是功能缺陷。

【约 2 分钟的测试步骤】
1. 打开 https://codemirror.net/try/  （CodeMirror 6 官方示例页）
2. 在编辑器里点一下，让光标落在代码区
3. 点击工具栏上的「贴进去」图标。弹窗打开后，顶部状态标签会显示识别结果，
   例如「就绪 · CodeMirror 6」
4. 在弹窗的输入框里粘贴一段文字，例如：console.log('hello')
5. 点击「插入」按钮，或按 Ctrl + Enter
6. 文字应当出现在编辑器里；页面右下角出现绿色提示条；
   弹窗可能自动关闭 —— 因为插入时页面抢走了焦点，这是正常现象
7. 再次点击图标，点「历史」按钮，可以看到刚才那次插入记录

【其他可测站点】
· Monaco  —— https://microsoft.github.io/monaco-editor/playground.html
· Ace     —— https://ace.c9.io/
· 普通输入框 —— 任意包含 textarea 的网页（例如 https://www.w3schools.com/tags/tryit.asp 的文本框）

【以下情况显示失败是预期行为，不是 bug】
· 在 edge:// 开头的页面、Edge 加载项商店、PDF 阅读器上，任何扩展都无法注入，
  弹窗会显示「受限页面」
· 页面里只有 iframe 内的编辑器时，v1 不支持，弹窗会明确提示
· 只读编辑器会被识别出来并跳过

【隐私】
扩展不发起任何网络请求。草稿和历史只写入本地 chrome.storage.local。
没有远程代码、没有分析统计、没有第三方 SDK。
```

---

## 6. 提交前最后一遍自查

- [ ] zip 里 `manifest.json` 在**根目录**（不是在某个文件夹里）
- [ ] `version` 比上一次提交的大（首次提交无所谓）
- [ ] 每个语言都传了 300×300 的 logo
- [ ] 描述 ≥ 250 字符
- [ ] 隐私政策 URL 能在**无痕窗口**里打开
- [ ] Notes for certification 里的测试网址你自己点得开
- [ ] 权限理由逐条填了，没有留空

---

## 7. 审核大概多久

首次提交通常 **1–7 个工作日**。状态在 Partner Center 的扩展详情页看：
`In review` → `Approved` / `Needs attention`。

被拒不会「封号」，按邮件里指的条款改完重新提交就行。最常见的两类：

| 拒绝理由 | 通常的真实原因 | 对策 |
| --- | --- | --- |
| 权限理由不充分 | 只写了「需要此权限」，没写**为什么非它不可** | 用上面 3.2 的版本，讲清楚 MAIN world 的技术必要性 |
| 单一用途不清 | 描述里塞了太多功能 | 只留「把文本插入编辑器」这一条主线 |
