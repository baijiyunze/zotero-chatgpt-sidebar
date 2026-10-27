# 注意：section 标题必须写成 .label 属性形式。
# 纯文本形式（xxx = AI 侧边栏）会让 Fluent 直接把文本塞进
# collapsible-section 的 textContent，清空它内部的 head/body 结构，
# 导致面板整个消失。这是 Zotero 10 实测踩过的坑。
zoterogpt-section-header =
    .label = AI 侧边栏
zoterogpt-section-sidenav =
    .tooltiptext = AI 助手
zoterogpt-menu-summarize =
    .label = 用 AI 总结所选文献
zoterogpt-menu-questions =
    .label = 用 AI 生成阅读问题
zoterogpt-menu-send-pdf =
    .label = 把这篇论文的 PDF 发到 AI 侧边栏（不切页）
zoterogpt-menu-open-tab =
    .label = 在标签页中打开 AI 助手
# section 标题栏右侧 📎 按钮的提示（实际 tooltiptext 由 bootstrap.js 直接写入，
# 这里留一份 FTL 只是为了万一 Fluent 先到不至于显示成裸 key）
zoterogpt-section-btn =
    .tooltiptext = 把当前论文的 PDF 送进这个对话（不切页）
# 标题栏 A− / A+ 两个缩放按钮
zoterogpt-section-btn-zoomout =
    .tooltiptext = 缩小字体（−10%）
zoterogpt-section-btn-zoomin =
    .tooltiptext = 放大字体（+10%）
# 标题栏的 AI 选择按钮（图标 = 当前服务的 logo，点开是带图标的服务菜单）
zoterogpt-section-btn-provider =
    .tooltiptext = 选择 AI 服务（ChatGPT / DeepSeek）
