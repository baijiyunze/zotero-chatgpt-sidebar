# 更新日志 / Changelog

## 1.7.0 — 支持 DeepSeek，一个插件两家通用

- **新增 DeepSeek 支持**：设置里多出「AI 服务」单选项（ChatGPT / DeepSeek），
  切换后侧边栏自动载入对应站点，不用重启
- 两家的差异（网址、登录域名、输入框与发送按钮选择器、发送方式）抽成
  `ZSC_PROVIDERS` 配置表，页面注入脚本按配置动态生成，只维护一份代码
- DeepSeek 的输入框是普通 `textarea#chat-input` 但被 React 接管，写入走
  原生 setter + `input` 事件；发送优先用回车（原生 Enter 发送），
  按钮只认能明确识别的，避免误点「深度思考 / 联网搜索」开关
- 「自定义网址」输入框移除，改为服务选择（网址随服务固定），避免切换服务后
  网址残留在另一家上导致白屏
- 插件更名为 **Zotero AI Sidebar**（addon id 不变，老用户可原地升级）

## 1.6.2 — 支持自动更新

- 新增 `build.py`：一键打包 xpi 并生成 Zotero 自动更新用的 `update.json`
- `manifest.json` 的 `update_url` 指向本仓库的 `update.json`
  （原值指向一个不存在的地址，导致自动更新实际不可用）
- 新增 `build.bat`：Windows 下双击即可填用户名出包
- 新增 `CHANGELOG.md`、`.gitignore`

> 从本版起，Zotero 会定期检查 `update_url` 并在有新版本时提示更新。

## 1.6.1 — 修复字体缩放不生效

**问题**：点 A− / A+ 完全没反应。

**根因**：`Zotero.Prefs.set()` 在该 pref 尚不存在时只接受布尔 / 字符串 / **整数**，
浮点数会直接抛 `Invalid preference value`。缩放值以 `0.85` 这样的浮点存储，
于是每次点击都在写偏好那一步抛异常，缩放永远停在默认 85%。

**修复**：

- 缩放改为存储**整数百分比** `zoomPercent`（默认 85），读取时兼容旧版浮点值
- 若 Zotero 插件 API 仍拒绝写入，兜底直接写 `Services.prefs`（已处理 Zotero
  在插件 key 前附加的 `extensions.zotero.` 前缀）
- 缩放应用改为**三条通道依次尝试**：`browsingContext` → `docShell` → 元素属性，
  并**读回校验**。Zotero 10 的 `browser-custom-element` 未必实现 `fullZoom`，
  原写法可能只是加了个静默失效的属性。真不生效时状态行会提示「缩放未生效」
- 默认配置 `prefs.js` 同步改为整数百分比

## 1.6.0 — 新增字体缩放调节

- **面板标题栏 A− / A+ 按钮**（纸飞机左侧）：每点一次 ±10%，即时生效，
  不弹系统小窗，只在面板底部小字显示当前值（如「缩放 90%」）
- 缩放范围放宽到 **50%–200%**（原上限 180%），新值会被记住，重启 Zotero 后保持
- 对「在标签页中打开 ChatGPT」的窗口同样生效
- **设置面板新增缩放控件**：`A− | 85% | A+ | 重置`，百分比实时跟随
- 新增 A− / A+ 图标（浅色 / 深色两套），中英文 tooltip 补齐

> 当前是**整页缩放**（fullZoom），布局会随字号一起缩放，不会挤变形。

## 1.5.5 — 精简提示文案

- 「PDF 已放进 ChatGPT 输入框（论文页保持不动），等文件卡片出现后按回车发送」
  → **「PDF 已放进输入框，按回车发送」**
- 未确认成功时的兜底提示同步缩短，英文版一并精简

## 1.5.4 — 修复 PDF 发送失败（重要）

**问题**：点纸飞机发 PDF，提示「没能把文件放进输入框（路径已复制）」。
日志显示文件读取成功、分片全部送达（`CHUNK 3/3`），但拼接时报错。

**根因**：拼接 PDF 字节时使用了**页面 window 的 `Uint8Array`**。Zotero 10.0.6
换用新 Gecko 内核后，**禁止沙箱代码跨 Xray 逐字节读写其他域的 TypedArray**：

```
JOIN_ERR: Accessing TypedArray data over Xrays is slow, and forbidden...
```

结果是 3 片数据都到了却拼不出缓冲区（`ATTACH_NO_BYTES`）。这是 Zotero 升级
触发的兼容性问题，与网络、操作无关。

**修复**：`ZSC_JOIN_CHUNKS` 与 `ZSC_LOOKS_PDF` 两处改用**沙箱自身的
`Uint8Array`**（同域访问不受限制），页面域的仅作兜底。
