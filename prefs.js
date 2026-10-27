/* Zotero ChatGPT Sidebar — 默认偏好设置
 * 这些值写入 default branch，用户在「设置 → ChatGPT 侧边栏」或 about:config 中修改后优先生效。
 */

pref("extensions.zoterogpt.provider", "chatgpt");
pref("extensions.zoterogpt.chatUrl", "https://chatgpt.com/");
// current = 直接发进面板里当前打开的对话（推荐）；clipboard = 只复制到剪贴板
pref("extensions.zoterogpt.sendMode", "current");
pref("extensions.zoterogpt.preferCurrentChat", true);
pref("extensions.zoterogpt.maxChars", 6000);
pref("extensions.zoterogpt.panelHeight", 560);
// true = 面板铺满侧边栏剩余高度（实测可用空间）；false = 用 panelHeight 固定高度，可拖拽调整
pref("extensions.zoterogpt.fillSidebar", true);
// 内嵌网页缩放（Zotero 的右侧栏很窄，默认缩一点更不容易出现横向滚动）
pref("extensions.zoterogpt.zoom", 0.8);
// 缩放按**整数百分比**存（Zotero.Prefs.set 不接受新建浮点 pref，见 bootstrap.js 注释）
pref("extensions.zoterogpt.zoomPercent", 85);
pref("extensions.zotero.extensions.zoterogpt.zoomPercent", 85);
pref("extensions.zoterogpt.autoOpen", true);
// true = 面板底部显示[诊断]行（排查加载失败时开，平时关掉腾出空间）
pref("extensions.zoterogpt.showDiag", false);
pref("extensions.zoterogpt.toastOnSend", true);
pref("extensions.zoterogpt.stripFrameHeaders", true);
pref("extensions.zoterogpt.plainUserAgent", true);
pref("extensions.zoterogpt.customUserAgent", "");
