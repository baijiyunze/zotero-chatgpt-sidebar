# NOTE: the section header MUST use the .label attribute form.
# A plain-text message makes Fluent inject the text as the
# collapsible-section's textContent, wiping its head/body children
# (the whole panel vanishes). Verified on Zotero 10.
zoterogpt-section-header =
    .label = AI Sidebar
zoterogpt-section-sidenav =
    .tooltiptext = AI assistant
zoterogpt-menu-summarize =
    .label = Summarize item with AI
zoterogpt-menu-questions =
    .label = Generate reading questions with AI
zoterogpt-menu-send-pdf =
    .label = Send this paper's PDF to the AI sidebar (stays on the page)
zoterogpt-menu-open-tab =
    .label = Open AI assistant in a tab
# Tooltip for the 📎 button in the section header (bootstrap.js writes the
# tooltiptext directly; kept here so Fluent never shows a bare key)
zoterogpt-section-btn =
    .tooltiptext = Send this paper's PDF into this conversation (stays on the page)
# A− / A+ zoom buttons in the section header
zoterogpt-section-btn-zoomout =
    .tooltiptext = Smaller text (−10%)
zoterogpt-section-btn-zoomin =
    .tooltiptext = Larger text (+10%)
# AI picker button in the section header (icon = current service logo)
zoterogpt-section-btn-provider =
    .tooltiptext = Choose AI service (ChatGPT / DeepSeek)
