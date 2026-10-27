# Zotero AI Sidebar

在 **Zotero 里直接使用网页版 AI 对话（ChatGPT / DeepSeek）** 的插件：

> **支持的服务**：ChatGPT（chatgpt.com）、DeepSeek（chat.deepseek.com）。
> 在 `工具 → AI 侧边栏` 设置里用「AI 服务」单选项切换，切换后侧边栏会自动载入对应站点。
> 两边的登录状态互相独立，各登录一次即可。

- **右侧栏内嵌 chatgpt.com**，登录个人账号（Free / Plus 均可），登录状态随 Zotero 配置保存，重启不丢
- **PDF / EPUB 划词 → 直接发到当前对话**：选中文字后弹窗多出「发送到 ChatGPT」按钮，选中的原文**原样**发进右侧栏里**当前打开的那个对话**——不加提示词、不新开对话、不跳回文库页面、不弹开阅读器左侧栏
- **一键把整篇论文 PDF 送进对话**（面板标题栏的纸飞机按钮，点一下就发，**不点不发**；另有阅读器正文右键、条目列表右键两个手动入口）。阅读器工具栏上的「ChatGPT / 📎 PDF」按钮已按用户要求移除（v1.5.3，功能重复）。PDF 只放进输入框、不自动提交，你按回车即可，于是可以让 GPT 结合全文逐句解释。**发送全程论文页原地不动**——不切标签页、不弹阅读器左右侧栏、不重开阅读器
- **文献条目右键** →「用 ChatGPT 总结所选文献 / 生成阅读问题」，自动带上标题、作者、摘要
- **面板铺满侧边栏**，纯净无工具栏：没有状态栏、按钮排，只有 ChatGPT 页面本身（v1.2.1 起）；v1.2.5 起页面直达侧边栏底部——拖拽条与提示行悬浮在页面底边，下方「信息」等 section 的实际高度也会被扣除，不再留白
- **保底方案**：侧栏页面万一加载不出来，可在设置里改用标签页模式（面板内嵌页不可用时，文字发送会自动退化为复制到剪贴板）

针对 **Zotero 10.0.3（Gecko 140，Windows）** 开发，兼容 Zotero 7+。

---

## 安装（重要：必须通过 Zotero 界面安装）

Zotero 10 **不会自动加载**直接放进配置文件目录的插件，必须走界面安装：

1. 打开 Zotero → 菜单 `工具 (Tools)` → `插件 (Add-ons)`
2. 右上角**齿轮图标** → **Install Plugin From File…**
3. 选择本目录下的 `dist/zotero-chatgpt-sidebar-1.7.0.xpi`（或从 Releases 页下载）
4. 按提示**重启 Zotero**

> 注意：不要用脚本把 xpi 复制到 `Profiles/.../extensions/` 来安装——实测 Zotero 10 完全忽略该目录下的新增插件（xpi 与解包目录都试过，`extensions.json` 里不会出现记录）。只有界面安装才会被接受。

安装后到 `工具 → 插件` 里确认 **Zotero AI Sidebar 1.7.0** 已启用。

## 自动更新

`manifest.json` 的 `update_url` 指向本仓库根目录的 `update.json`：

```
https://raw.githubusercontent.com/baijiyunze/zotero-chatgpt-sidebar/main/update.json
```

Zotero 会定期检查该文件，版本号更高时提示更新。发新版的流程见
[UPLOAD_GUIDE.md](UPLOAD_GUIDE.md)，本地打包只需双击 `build.bat`。

## 使用

1. 选中任意条目 → 右侧栏出现 **「ChatGPT 侧边栏」** section（GPT 图标），它会自动展开，里面就是 chatgpt.com
2. 首次先在面板里**登录** ChatGPT（登录状态随 Zotero 配置文件保存）
3. 在面板里切到你想要的那个对话（这一步很关键：发送目标就是**面板当前显示的这个对话**）
4. 打开 PDF → **划词** → 点弹窗里的「**发送到 ChatGPT**」
   - 选中的文字直接进面板输入框并被提交，**不会新开对话、不会跳回文库页面、不会顶掉你正看着的对话**
   - 划词只会展开**右侧栏**（条目面板 + 插件 section）；PDF 阅读器的**左侧栏**（缩略图/注释）不会被弹开（v1.2.4 起）
   - 面板还没加载好时，插件会**等它就绪**再发送；实在等不到（约 11 秒）才退化为复制到剪贴板，并明确告诉你「没有新开对话」
   - 确实想新开一个对话时：把设置里的「优先发送到当前对话」关掉，就回到 `?q=` 新对话的老行为
5. **发送整篇论文 PDF**（v1.4.0 起；v1.5.1 起只保留手动按钮，**点按钮才发、不点不发**）
   - **手动**（三种入口任选）：插件面板标题栏右侧的**纸飞机**按钮 / 阅读器正文右键或条目列表右键里的「把这篇论文的 PDF 发到…」（v1.5.3 起阅读器工具栏不再放按钮）
   - PDF 会被放进面板里**当前对话**的输入框，**不会自动提交**，你按回车或先补一句提问（例如「先用中文概述，然后等我指定句子逐句解释」）
   - 发送期间**论文页完全不动**：不切标签页、不弹阅读器左/右侧栏、不重开阅读器——发完可以立刻接着在原页划句提问
   - 上限 60MB；传输优先用系统级 `XMLHttpRequest` 直读 `file://`，失败才回退到 45 万字节分片 + base64 拼装
   - 万一面板没就绪：先等约 5 秒，还不行就挂起，等面板挂载后自动补发；始终等不到会提示你去面板里登录
6. 条目列表右键 →「用 ChatGPT 总结所选文献」
7. `编辑 → 设置 → ChatGPT 侧边栏`：可改网址（支持镜像站）、面板铺满开关、发送方式、字符上限、UA 策略等

### 面板上还有什么

| 元素 | 作用 |
| --- | --- |
| ChatGPT 页面 | 整个面板就是内嵌网页，无工具栏、无按钮排（v1.2.1 起） |
| section 标题栏右侧的纸飞机 | v1.5.0 起新增：点一下把当前论文的 PDF 送进对话。只占标题栏一个小图标位，不给面板加工具栏；v1.5.3 起阅读器工具栏的「ChatGPT / 📎 PDF」按钮已移除 |
| 底部横条 | 拖动调整面板高度（拖过之后自动退出「铺满」模式） |
| 底部小字（hint） | 仅在需要时短暂出现：加载中 / 已发送 / 已复制 / 加载失败原因 |
| section 标题栏右侧的 A− / A+ | v1.6.0 起新增：点一下放大/缩小内嵌页面（每次 ±10%，范围 50%–200%），立即生效并记住 |
| 缩放 | 也可在设置面板里用 A− / 百分比 / A+ / 重置调节；等价于偏好 `extensions.zoterogpt.zoom`（默认 0.85） |

## 工作原理

- **内嵌网页**：`<browser type="content">` 元素用 `document.createXULElement("browser")` 创建（**不能用 `parseXULToFragment` 或 HTML 元素**，否则得到的不是真正的浏览器元素，不渲染内容），插入右侧栏 section 的面板容器中
- **突破框架限制**：chatgpt.com 用 `X-Frame-Options` / CSP `frame-ancestors` 禁止被框架嵌入。插件注册 `http-on-examine-response` 观察器，仅对 ChatGPT 及其登录相关域名在响应阶段剥离这两个响应头
- **规避风控**：通过 `browsingContext.customUserAgent` 把内嵌页面的 UA 设为去掉 `Zotero/x.y` 后缀的普通 Firefox UA（**同时作用于请求头和 `navigator.userAgent`**，保持指纹一致，避免被 Cloudflare 判定为异常客户端）
- **把文字送进当前对话**：内嵌网页跑在独立内容进程，插件在父进程拿不到它的 DOM（remote browser 的 `contentWindow` 为 null）。这里用 Zotero 官方提供的
  `ChromeUtils.importESModule("chrome://zotero/content/RemoteTranslate.mjs")` 通道：它把翻译框架连同我们临时构造的一个「伪 translator」（`translatorType: 4`、`browserSupport: "gcsibv"`、**`runMode: 1`**）注入该网页，`doWeb(doc, url)` 就在页面里执行——找输入框、落光标、`execCommand("insertText")` 写入、点发送按钮。
  实现要点（踩过的坑）：
  - translator 代码必须以**一段 JSON 头部**开头，因为 Zotero 是 `ZOTERO_TRANSLATOR_INFO = <code>` 这样求值的
  - **必须显式给 `runMode: 1`**。传的是普通对象、没经过 `Zotero.Translator` 构造函数，缺这个字段 `Translate.Web` 会当成"该发 RPC"，`detect()` 直接返回空、`doWeb` 永不执行
  - **不要用 `document.execCommand("selectAll")` 来清空输入框**——在 contenteditable 里它可能选中整页，随后的 `insertText` 会把整个页面替换掉。正确做法是 `Range.selectNodeContents(ed)` + `collapse(false)` 把光标放到输入框末尾
  - 页面回传状态走翻译框架的 `debug` handler（`Zotero.debug("ZSC:...")` → `RemoteTranslate.setHandler("debug", ...)`）
- **面板高度**：不再写死像素，改为实测「窗口可视高度 − 面板顶部 y 坐标 − 下方 section 实际高度」，在窗口尺寸变化、其他 section 折叠/展开（MutationObserver 监听）时重算，从而铺满侧边栏
- **把整篇 PDF 送进对话**（v1.4.0 起）：难点是内嵌网页在独立内容进程，父进程既拿不到它的 DOM，也无法把 `File` 对象直接塞过去。仍借 `RemoteTranslate` 通道，分两路搬字节：
  1. **直读（优先）**：注入脚本用 `RemoteTranslate` 建沙箱时注入的**系统级 `XMLHttpRequest`**（`wantGlobalProperties`）去读 `file://` —— 这是整条链路里唯一能碰本地文件的地方。注意 `file://` 成功时 `status` 是 **0**，只能看 `response.byteLength` 和前 5 字节是否为 `%PDF-`
  2. **分片（兜底）**：父进程读文件 → 按 450000 字节（3 的倍数，base64 不带 `=` 补齐）切片 → base64 随注入代码一片片送进页面 → 页面 `atob` 拼回 `Uint8Array`
  之后 `new DataTransfer()` + `new File([buf], name, {type:"application/pdf"})` → 写进 `input[type=file].files` → 派发 `input` + `change`（跳过 `accept="image/*"` 的输入框；写不进去才退回模拟拖放，两者只做其一，否则会上传两次）。**多步注入复用同一个 `RemoteTranslate`**（`setBrowser` 会重建沙箱，很贵），每步换 `translatorID` 避开代码缓存，步骤间状态挂在页面 `window.wrappedJSObject` 上
- **零导航保证**：PDF 全链路（`zscSendPdf` / `zscPdfUpload` / `zscResolvePdf` / `zscEnsureVisible`、`zscOnPaneButtonClick` …）不得出现 `Zotero_Tabs.select(`、`selectItem(`、`Zotero.Reader.open(`、`toggleSidebar(`、`zscNavigate(`——由 `_recon/check_pdf_nav_safety.py` 静态守住，并断言**不存在任何自动发送逻辑**（v1.5.1 起发送只能由按钮触发）
- **图标条点击（v1.5.1）**：右侧栏图标条的一格对应一个 section，`data-pane` 实际是 Zotero 命名空间化后的 `CSS.escape("<pluginID>-<paneID>")`，所以只能按后缀认；单击图标 Zotero 只做 `scrollToPane`（不会展开折叠的 section），插件在文档级委托监听这个点击，顺手展开面板——**不触发任何发送**
- **划词取文**：`Zotero.Reader.registerEventListener("renderTextSelectionPopup" / "renderToolbar" / "createViewContextMenu")`
- **右侧栏**：`Zotero.ItemPaneManager.registerSection`；section 标题的 FTL 必须写成 `.label` 属性形式（纯文本形式会清空 section 子元素，导致面板消失）
- **菜单**：`Zotero.MenuManager.registerMenu`（target: `main/library/item`）

## 故障排查

插件会把关键步骤写进一份日志，出问题可直接看它：

```
%APPDATA%\Zotero\Zotero\Profiles\<你的 profile>\zsc_debug.log
```

日志里 `inject: ...` 一行会给出注入过程的全部回传信息（`COMPOSER` / `INSERTED` / `SENT_BUTTON` / `NO_COMPOSER` / `INSERT_FAILED` …）；`[load]`、`[t+12s]` 这类行给出浏览器当前 URL、页面标题、元素高度。比如标题是 `Just a moment...` 说明卡在 Cloudflare 人机验证。

| 现象 | 处理 |
| --- | --- |
| 打开论文后没自动送 PDF | 看 `zsc_debug.log` 里 `auto-pdf:` 开头的行：`no paper in context` = 当前没有可识别的论文；`has no PDF attachment` = 该条目没有 PDF 附件；`already sent for this conversation` = 这个对话里已经有了（去重生效，换对话或手动点 📎 即可）；`debounced` = 8 秒内已经触发过 |
| 侧栏空白 | 先看 `zsc_debug.log`；也可把面板里的地址复制到 Zotero 主界面或系统浏览器打开验证 |
| 卡在人机验证 / 提示浏览器不受支持 | 设置里确认「用普通浏览器 User-Agent 访问」开启；或在面板里先完成一次验证 |
| Google / Microsoft 账号登录弹窗 | 建议用**邮箱 + 密码**登录，第三方 OAuth 弹窗可能被 Zotero 拦截 |
| 面板太矮 / 想更宽 | 默认已铺满；拖动面板底部横条可手动改高度 |
| 划词后文字没进输入框 | 看面板底部小字与日志里的 `inject:` 行：`NO_COMPOSER` = 面板没停在 ChatGPT 页面或没登录；`detect-empty` = 页面还没加载完，等几秒重试。此时文字已复制到剪贴板 |
| 提示「发送失败」但内容其实进去了 | **v1.2.3 起已修**。页面回传消息带的 `ZSC:` 前缀原先没被剥掉，导致 `SENT_*` 判定一律不成立 → 明明发出去了却报失败。用旧版时看日志：只要 `INSERTED` 与 `SENT_BUTTON` 同时出现，内容就已经发进对话了，**不要再重复点**，否则会发出去好几条 |
| `SENT_BUTTON_UNCLEAR` | 内容已写进输入框，但点发送后输入框没清空（按钮可能没被页面接住）。此时会自动再补一次回车；仍不确定就提示「已放进输入框，请自行按回车」，**不会**误报成失败 |
| 不想自动发送 | 设置 → 发送方式 → 「只复制到剪贴板，手动粘贴」 |
| 发送 PDF 没反应 | 看日志里的 `pdf step n:` 行。`PROBE_OK` = 直读本地文件成功；`CHUNK i/n` = 在用分片兜底；`FILE ok` / `INPUTS n` / `INPUT[i] accept=…` / `CHANGE_DISPATCHED` = 已写进输入框；`ATTACHED_VERIFIED` = 文件卡片已出现。`ATTACHED_UNCHECKED` 表示放进去了但没确认到卡片，看一眼输入框即可 |
| 提示「没找到可发送的 PDF」 | 该条目没有 PDF 附件，或阅读器里还没打开论文。把光标停在阅读器里、或先选中带 PDF 的条目再点 |
| 提示「面板里的 ChatGPT 还没就绪」 | 面板未登录或页面没加载完。在面板里登录后重试；插件最多等约 5 秒，然后会挂起、等面板挂载后自动补发 |
| 想排查加载细节 | 设置里打开「面板底部显示诊断行」（pref `extensions.zoterogpt.showDiag`） |

## 隐私说明

划词内容与条目元数据只会发送到你配置的 ChatGPT 服务（默认 chatgpt.com）。插件不收集任何数据；UA 覆盖与响应头剥离仅针对上述域名。日志文件只记录加载状态与本机 URL，不含对话内容。

## 开发

```
zotero-chatgpt-sidebar/
├── manifest.json          # WebExtension 风格清单（applications.zotero 需含 id / update_url / strict_max_version）
├── bootstrap.js           # 全部逻辑：右侧栏 section / 内嵌浏览器 / 注入 / 划词 / 菜单 / 标签页模式
├── prefs.js               # 默认偏好（default branch）
├── content/prefs.xhtml    # 设置面板（XUL 片段）
├── content/icons/         # section 图标（GPT 标志，浅色/深色）与插件图标
└── locale/{zh-CN,en-US}/zoterogpt.ftl
```

打包脚本在工程外：`../_recon/build_xpi.py`（自动遍历收录 + 资源引用反向校验 + zip 完整性 + 包内 sha256 比对）。

```bash
python ../_recon/build_xpi.py    # 打包到 dist/
```

## 已知限制

- 面板必须**停在 ChatGPT 页面上**才能注入；面板没加载完 / 未登录时会退化为复制到剪贴板
- 发送目标是「面板当前打开的那个对话」。想换目标，先在面板里切换对话
- ChatGPT 改版（输入框 DOM、发送按钮 testid）可能影响注入，此时文字会退化为复制到剪贴板，并可从 `zsc_debug.log` 的 `inject:` 行定位
- PDF 发送只把文件**放进输入框**，不会自动提交——这是刻意的，方便你先补一句提问（如「等我指定句子再逐句解释」）。自动发送时也**不会**替你按回车
- 自动发送只在「阅读器标签页」或「点插件图标」时触发，**不会**在文库列表里翻条目时乱传；同一对话里同一篇论文也只传一次
- PDF 上限 60MB；传的是本地附件原文件，链接式（Linked URL）附件本地无文件时会排在最后
- 「你选中的对话」= 面板**当前显示**的那个对话；插件不会替你切换对话，也不会替你切 Zotero 页面
- 未做 OpenAI API 接入（本插件定位是「网页版账号直用」）；如需 API 模式可配合 llm-for-zotero
