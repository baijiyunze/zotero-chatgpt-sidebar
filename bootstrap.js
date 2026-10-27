/*
 * Zotero ChatGPT Sidebar — Zotero 7+ / 10 bootstrap plugin
 *
 * 功能：
 *  1. 在 Zotero 右侧栏（条目面板）内嵌 chatgpt.com 网页版，可登录个人账号（Cookie 持久化）
 *  2. PDF / EPUB 阅读器划词菜单：总结 / 解释，一键把选中文本发到侧边栏提问
 *  3. 文献条目右键菜单：用 ChatGPT 总结文献、生成阅读问题
 *  4. ChatGPT 页面被 X-Frame-Options / CSP frame-ancestors 拦住时，自动剥离这两个响应头
 */

"use strict";

const ZSC_ID = "zoterogpt-sidebar@workbuddy.local";
const ZSC_PREFIX = "extensions.zoterogpt.";
// Zotero.Prefs.* 会在插件的 key 前面再加一层 ZOTERO_CONFIG.PREF_BRANCH（"extensions.zotero."），
// 写 Mozilla 原生 pref 分支时要带上它。
const ZSC_PREF_BRANCH = "extensions.zotero." + ZSC_PREFIX;
// 标签页模式（侧栏不可用时的保底方案）使用的 tab 类型标识
const ZSC_TAB_TYPE = "zoterogpt-chatgpt";
// 注入用"伪 translator"的 ID。Zotero 的 RemoteTranslate 需要一个 translator 对象，
// 这个 ID 只用于日志区分，不会真的写进翻译器仓库。
const ZSC_INJECT_ID = "zoterogpt-inject@workbuddy.local";
// 把本地 PDF 送进页面时的分片大小：必须是 3 的倍数，这样每片 base64 都不带 "=" 补齐，
// 页面侧 atob 拼接才不会错位。45 万字节 ≈ 600KB base64，一次注入不至于卡住。
const ZSC_PDF_CHUNK_BYTES = 450000;
const ZSC_PDF_MAX_BYTES = 60 * 1024 * 1024;
const ZSC_B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// 图标 URL 统一加版本查询串：同 URL 重装插件时 Gecko 可能命中图片缓存（甚至
// 缓存过失败的加载），带 ?v= 让每次发版都是新 URL，强制重新加载。
const ZSC_ICONS_REV = "7";
function zscIconURL(name, rootURI) {
	return (rootURI || ZSC.rootURI) + "content/icons/" + name + "?v=" + ZSC_ICONS_REV;
}

// 支持的内置 AI 服务。差异全部集中在这张表里，页面脚本按配置动态生成。
//  - hosts        : 需要剥离 X-Frame-Options / CSP 的域名（含登录相关域名）
//  - composer/send: 输入框与发送按钮的选择器（按优先级从上到下试）
//  - preferEnter  : true = 优先回车发送（DeepSeek），false = 优先点发送按钮（ChatGPT）
const ZSC_PROVIDERS = {
	chatgpt: {
		id: "chatgpt",
		label: "ChatGPT",
		url: "https://chatgpt.com/",
		hosts: [
			"chatgpt.com",
			"chat.openai.com",
			"openai.com",
			"auth.openai.com",
			"auth0.openai.com",
			"accounts.google.com",
			"appleid.apple.com",
			"login.microsoftonline.com",
			"login.live.com",
		],
		cookieHost: "chatgpt.com",
		sessionCookie: "session-token|oai-client-auth|__Secure-next-auth|oai-did|_account",
		composer: [
			"#prompt-textarea",
			"div.ProseMirror[contenteditable=\"true\"]",
			"div[contenteditable=\"true\"]",
			"textarea[data-id]",
			"textarea",
		],
		send: [
			"button[data-testid=\"send-button\"]",
			"#composer-submit-button",
			"button[aria-label*=\"Send\"]",
			"button[aria-label*=\"发送\"]",
			"button.composer-submit-button-color",
		],
		preferEnter: false,
		// 图标文件（标题栏按钮 / 下拉菜单 / 侧栏图标随当前服务切换）
		icon: "openai-16.svg",
		darkIcon: "openai-16-dark.svg",
		icon20: "openai-20.svg",
		darkIcon20: "openai-20-dark.svg",
	},
	deepseek: {
		id: "deepseek",
		label: "DeepSeek",
		url: "https://chat.deepseek.com/",
		hosts: [
			"chat.deepseek.com",
			"deepseek.com",
			"platform.deepseek.com",
			"open.weixin.qq.com",
		],
		cookieHost: "chat.deepseek.com",
		sessionCookie: "token|session|auth|user|ds_|login",
		// DeepSeek 输入框是普通 textarea，但被 React 接管，写入必须走原生 setter。
		// 新版页面已经去掉了 id（日志里显示 id=-），所以 textarea 兜底是主路径，
		// 末尾再挂 contenteditable / role=textbox，防止它哪天改成富文本框。
		composer: [
			"#chat-input",
			"textarea#chat-input",
			"textarea",
			"div[contenteditable=\"true\"]",
			"[role=\"textbox\"]",
		],
		// 发送按钮只认能明确识别的，找不到就交给回车；
		// 页面上还有「深度思考 / 联网搜索」等开关，绝不能用 div[role=button] 兜底乱点。
		send: [
			"button[type=\"submit\"]",
			"div[aria-label*=\"发送\"]",
			"button[aria-label*=\"发送\"]",
			"div[aria-label*=\"Send\"]",
			"button[aria-label*=\"Send\"]",
		],
		preferEnter: true,
		// DeepSeek 在首页发出第一条消息时会整页跳到 /a/chat/s/...，页面 window global
		// 一换，Zotero 注入用的 translator actor 就被销毁。所以它必须"派发完就返回"，
		// 不能等结果——否则 translate() 一定以 Actor destroyed 报失败。
		noWait: true,
		icon: "deepseek-16.svg",
		darkIcon: "deepseek-16-dark.svg",
		icon20: "deepseek-20.svg",
		darkIcon20: "deepseek-20-dark.svg",
	},
};

/** 当前选中的服务（偏好 extensions.zoterogpt.provider，默认 chatgpt） */
function zscProv() {
	let id = String(zscGetPref("provider", "chatgpt") || "chatgpt").trim().toLowerCase();
	return Object.prototype.hasOwnProperty.call(ZSC_PROVIDERS, id)
		? ZSC_PROVIDERS[id]
		: ZSC_PROVIDERS.chatgpt;
}

/** 所有内置服务的 id 列表（下拉菜单按这个顺序展示） */
function zscProviderIDs() {
	return Object.keys(ZSC_PROVIDERS);
}

/** 服务图标 URL；small=false 用 20px 版本（下拉菜单 / 侧栏图标签） */
function zscProvIconURL(provId, dark, small) {
	let prov = ZSC_PROVIDERS[provId] || ZSC_PROVIDERS.chatgpt;
	let name = small
		? (dark ? prov.darkIcon20 : prov.icon20)
		: (dark ? prov.darkIcon : prov.icon);
	return zscIconURL(name);
}

/** host 是否属于给定域名列表（含子域） */
function zscHostIn(host, list) {
	if (!host) {
		return false;
	}
	let h = String(host).toLowerCase();
	for (let domain of (list || [])) {
		if (h === domain || h.endsWith("." + domain)) {
			return true;
		}
	}
	return false;
}

/** 所有内置站点的域名并集：响应头剥离用它，切换服务后不用重启 */
function zscAllChatHosts() {
	let out = [];
	for (let key in ZSC_PROVIDERS) {
		out = out.concat(ZSC_PROVIDERS[key].hosts || []);
	}
	return out;
}

const ZSC_CHAT_HOSTS = zscAllChatHosts();

// 条目级快捷提问（用于条目右键菜单）。
// 注意：划词发送不做任何包装——选中什么就发什么，所以这里没有划词模板。
const ZSC_ITEM_PROMPTS = {
	item: '请阅读并总结这篇文献，用中文分条输出：1) 研究问题 2) 方法 3) 主要结论 4) 创新点 5) 局限与疑问。\n\n题目：{title}\n作者：{creators}\n年份：{date}\n来源：{publication}\n摘要：{abstract}',
	questions: '请基于下面这篇文献，用中文提出 5 个值得深入探究的问题，并说明每个问题的入手方向。\n\n题目：{title}\n摘要：{abstract}',
};

const ZSC_STR = {
	zh: {
		reload: "刷新",
		home: "首页",
		login: "去登录",
		external: "浏览器打开",
		tab: "标签页",
		openPanel: "打开 AI 侧边栏",
		summary: "总结",
		explain: "解释",
		menuSummarize: "用 AI 总结所选文献",
		menuQuestions: "用 AI 生成阅读问题",
		menuOpen: "打开 AI 侧边栏",
		sendToChat: "发送到对话框",
		sent: "已发送到对话框",
		sentCurrent: "已发送到当前对话",
		sentUnclear: "文字已放进输入框，但没确认发出——去侧边栏看一眼，必要时按回车",
		sentNew: "已在新对话中发送",
		noComposer: "没找到 AI 输入框（可能未登录或页面还没加载完）",
		copied: "内容已复制，去侧边栏输入框 Ctrl+V 粘贴即可",
		sentTruncated: "内容较长：已截断后发送，完整文本已复制到剪贴板",
		zoomOut: "缩小",
		zoomIn: "放大",
		zoomReset: "恢复 100%",
		sendPdf: "把这篇论文的 PDF 发到对话",
		sendPdfBtn: "把当前论文的 PDF 送进这个对话（不切页）",
		providerBtn: "选择 AI 服务（当前：%s）",
		menuSendPdf: "把 PDF 发到 AI 侧边栏",
		pdfNoPaper: "没找到可发送的 PDF：请在阅读器里打开一篇论文，或选中一条带 PDF 附件的文献",
		pdfReading: "正在读取 PDF…",
		pdfBusy: "上一次发送还在进行中，请等它完成…",
		pdfUploading: "正在把 PDF 送进对话…",
		pdfWaitingPanel: "等待侧边栏就绪…",
		pdfNotReady: "侧边栏还没就绪（未登录或页面还在加载），在面板里登录后再试一次",
		pdfDone: "PDF 已放进输入框，按回车发送",
		pdfDoneUnverified: "PDF 可能已放进输入框，看一眼有没有文件卡片",
		pdfFailed: "PDF 发送失败",
		noText: "没有取到选中的文本",
		needLogin: "未检测到登录状态，点「去登录」",
		loggedIn: "已登录",
		loadFail: "侧边栏内加载失败，可点「浏览器打开」",
		loading: "正在加载…",
		ready: "",
	},
	en: {
		reload: "Reload",
		home: "Home",
		login: "Log in",
		external: "Open in browser",
		tab: "Tab",
		openPanel: "Open AI sidebar",
		summary: "Summarize",
		explain: "Explain",
		menuSummarize: "Summarize item with AI",
		menuQuestions: "Generate reading questions with AI",
		menuOpen: "Open AI sidebar",
		sendToChat: "Send to sidebar",
		sent: "Sent to the sidebar",
		sentCurrent: "Sent to the current conversation",
		sentUnclear: "Text is in the input box but sending wasn't confirmed — check the sidebar, press Enter if needed",
		sentNew: "Sent as a new conversation",
		noComposer: "AI input box not found (not signed in, or page still loading)",
		copied: "Copied — paste into the sidebar input box with Ctrl+V",
		sentTruncated: "Long text: sent truncated, full text copied to clipboard",
		zoomOut: "Zoom out",
		zoomIn: "Zoom in",
		zoomReset: "Reset to 100%",
		sendPdf: "Send this paper's PDF to the chat",
		sendPdfBtn: "Send this paper's PDF into this conversation (without leaving the page)",
		providerBtn: "Choose AI service (current: %s)",
		menuSendPdf: "Send PDF to the AI sidebar",
		pdfNoPaper: "No PDF found — open a paper in the reader, or select an item that has a PDF attachment",
		pdfReading: "Reading PDF…",
		pdfBusy: "Still sending the previous file — hang on…",
		pdfUploading: "Sending the PDF into the chat…",
		pdfWaitingPanel: "Waiting for the sidebar…",
		pdfNotReady: "The sidebar isn't ready yet (not signed in, or still loading). Sign in and try again.",
		pdfDone: "PDF placed — press Enter when the file card appears",
		pdfDoneUnverified: "PDF probably placed — check for a file card",
		pdfFailed: "Sending the PDF failed",
		noText: "No selected text",
		needLogin: "Login not detected. Click \"Log in\".",
		loggedIn: "Signed in",
		loadFail: "Failed to load the page inside the panel. Try \"Open in browser\".",
		loading: "Loading…",
		ready: "",
	},
};

const ZSC_PANEL_CSS = `
/* 让自定义 section 的 body 去掉内边距，面板才能真正铺满侧边栏宽度 */
item-pane-custom-section[data-pane$="zoterogpt"] [data-type="body"],
item-pane-custom-section[data-pane$="zoterogpt"] .body,
#zsc-root {
	padding: 0 !important;
	margin: 0 !important;
}
item-pane-custom-section[data-pane$="zoterogpt"] {
	--zsc-max-width: none;
}
#zsc-root {
	display: flex;
	flex-direction: column;
	width: 100%;
	max-width: none;
	box-sizing: border-box;
	font: menu;
	overflow: hidden;
	position: relative;
}
#zsc-root .zsc-browser-host {
	width: 100%;
	min-width: 0;
	min-height: 200px;
	flex: 1 1 auto;
	overflow: hidden;
	border: 0;
	border-radius: 0;
	background: #ffffff;
}
#zsc-root .zsc-browser-host > browser {
	width: 100%;
	min-width: 0;
	height: 100%;
	min-height: 200px;
	flex: 1 1 auto;
	border: 0;
	margin: 0;
}
/* 填充模式：高度由 JS 量出"从面板顶部到侧边栏底部"的可用空间，铺满不留白。
   拖拽条 / 提示行 / 诊断行全部悬浮在页面底部，不占布局高度——
   否则 ChatGPT 页面永远差那么两三十像素到不了侧边栏底部。 */
#zsc-root.zsc-fill {
	min-height: 260px;
}
#zsc-root.zsc-fill .zsc-browser-host,
#zsc-root.zsc-fill .zsc-browser-host > browser {
	min-height: 200px;
}
#zsc-root.zsc-fill .zsc-resizer {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 6;
	border-bottom: 0;
	border-top: 1px solid rgba(128, 128, 128, 0.25);
	background: linear-gradient(to top, transparent 0, transparent 2px, rgba(128, 128, 128, 0.05) 2px);
}
#zsc-root.zsc-fill .zsc-hint {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 8px;
	z-index: 5;
	padding: 4px 8px;
	background: rgba(252, 252, 252, 0.95);
	border-top: 1px solid rgba(128, 128, 128, 0.25);
}
#zsc-root.zsc-fill .zsc-diag {
	position: absolute;
	left: 0;
	right: 0;
	bottom: calc(8px + 2.4em);
	z-index: 5;
	padding: 4px 8px;
	background: rgba(252, 252, 252, 0.95);
	border-top: 1px solid rgba(128, 128, 128, 0.25);
}
/* 没有内容时彻底退出布局，别占一条白边 */
#zsc-root.zsc-fill .zsc-hint:empty,
#zsc-root.zsc-fill .zsc-diag:empty {
	display: none;
}
#zsc-root .zsc-diag {
	font-size: 10px;
	opacity: 0.6;
	line-height: 1.4;
	padding-top: 3px;
	white-space: pre-wrap;
	word-break: break-all;
	max-height: 6.5em;
	overflow: auto;
}
#zsc-root .zsc-resizer {
	height: 7px;
	flex: 0 0 auto;
	cursor: ns-resize;
	background: linear-gradient(to bottom, transparent 0, transparent 2px, rgba(128, 128, 128, 0.05) 2px);
	border-bottom: 1px solid rgba(128, 128, 128, 0.25);
}
#zsc-root .zsc-hint {
	font-size: 10.5px;
	opacity: 0.65;
	line-height: 1.45;
	padding-top: 5px;
}
`;

const ZSC_SEL_CSS = `
.zsc-sel-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px 4px;
	border-top: 1px solid rgba(128, 128, 128, 0.3);
	margin-top: 6px;
}
.zsc-sel-btn {
	appearance: none;
	font: inherit;
	font-size: 12px;
	padding: 3px 9px;
	border-radius: 5px;
	border: 1px solid rgba(128, 128, 128, 0.4);
	background: rgba(128, 128, 128, 0.16);
	color: inherit;
	cursor: pointer;
}
.zsc-sel-btn:hover { background: rgba(128, 128, 128, 0.32); }
`;

var ZSC;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function zscLog(msg) {
	try {
		Zotero.debug("[ZoteroChatGPT] " + msg);
	}
	catch (e) { /* ignore */ }
	zscFileLog(msg);
}

// 直接写文件的黑匣子日志：Zotero 的 debug 输出默认不落盘，
// 出问题时在 <profile>/zsc_debug.log 总能看到渲染链路走到了哪一步
function zscFileLog(msg) {
	try {
		let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
		file.initWithPath(Zotero.Profile.dir);
		file.append("zsc_debug.log");
		let stream = Cc["@mozilla.org/network/file-output-stream;1"]
			.createInstance(Ci.nsIFileOutputStream);
		// PR_WRONLY | PR_CREATE_FILE | PR_APPEND
		stream.init(file, 0x02 | 0x08 | 0x10, 0o666, 0);
		let line = "[" + new Date().toISOString() + "] " + msg + "\n";
		stream.write(line, line.length);
		stream.close();
	}
	catch (e) { /* ignore */ }
}

function zscError(e) {
	try {
		Zotero.logError(e);
	}
	catch (err) { /* ignore */ }
	zscFileLog("ERROR: " + (e && e.stack ? e.stack : e));
}

function zscGetPref(name, fallback) {
	try {
		let value = Zotero.Prefs.get(ZSC_PREFIX + name);
		if (value === undefined || value === null) {
			value = fallback;
		}
		return value;
	}
	catch (e) {
		return fallback;
	}
}

function zscSetPref(name, value) {
	try {
		Zotero.Prefs.set(ZSC_PREFIX + name, value);
	}
	catch (e) {
		zscError(e);
	}
}

function zscIsZh() {
	try {
		return String(Zotero.locale || "").toLowerCase().startsWith("zh");
	}
	catch (e) {
		return true;
	}
}

function zscT(key) {
	let table = zscIsZh() ? ZSC_STR.zh : ZSC_STR.en;
	return table[key] || ZSC_STR.en[key] || key;
}

function zscIsChatHost(host) {
	if (!host) {
		return false;
	}
	let h = String(host).toLowerCase();
	for (let domain of ZSC_CHAT_HOSTS) {
		if (h === domain || h.endsWith("." + domain)) {
			return true;
		}
	}
	return false;
}

function zscTruncate(text, limit) {
	if (!limit || text.length <= limit) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, limit), truncated: true };
}

function zscCopyToClipboard(text) {
	try {
		let helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
		helper.copyString(text);
		return true;
	}
	catch (e) {
		zscError(e);
		return false;
	}
}

function zscToast(win, message) {
	try {
		let options = { closeOnClick: true };
		if (win) {
			options.window = win;
		}
		let pw = new Zotero.ProgressWindow(options);
		pw.changeHeadline(zscProv().label);
		pw.addDescription(message);
		pw.show();
		pw.startCloseTimer(3500);
	}
	catch (e) {
		zscLog("toast failed: " + e);
	}
}

function zscChatURL(prompt) {
	let base = String(zscProv().url || "").trim();
	if (!base) {
		base = ZSC_PROVIDERS.chatgpt.url;
	}
	if (!prompt) {
		return base;
	}
	let sep = base.includes("?") ? "&" : "?";
	return base + sep + "q=" + encodeURIComponent(prompt);
}

function zscNavigate(browser, url) {
	if (!browser || !url) {
		return false;
	}
	let principal = Services.scriptSecurityManager.getSystemPrincipal();
	let ok = false;
	// 首选：字符串形式的 loadURI（Gecko 140 支持，最稳）
	try {
		browser.loadURI(url, { triggeringPrincipal: principal });
		ok = true;
	}
	catch (e) {
		zscLog("loadURI(str) failed: " + e);
	}
	if (!ok) {
		try {
			browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: principal });
			ok = true;
		}
		catch (e2) {
			zscLog("loadURI(uri) failed: " + e2);
		}
	}
	if (!ok) {
		try {
			browser.setAttribute("src", url);
			ok = true;
		}
		catch (e3) {
			zscError(e3);
		}
	}
	zscLog("navigate ok=" + ok + " -> " + String(url).slice(0, 140));
	return ok;
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function install(data, reason) {
	zscLog("install");
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
	try {
		await Zotero.initializationPromise;
	}
	catch (e) { /* ignore */ }

	if (!rootURI) {
		rootURI = resourceURI.spec;
	}

	ZSC = {
		id,
		version,
		rootURI,
		ready: false,
		sectionID: null,
		menuID: null,
		readerHandlers: [],
		httpObserver: null,
		windows: new WeakSet(),
		panel: null,
		mounts: 0,
		// 上一次实际生效的服务 id：用来判断"真的换了"，避免重复导航
		lastProvider: null,
		// 打开中的 AI 服务下拉菜单 { el, doc, anchor, cleanup }
		provMenu: null,
		// 待注入"面板当前对话"的划词内容（面板还没就绪时暂存）
		pendingPrompt: null,
		// 待"新开对话"的提问，与 pendingPrompt 语义不同，别混用
		pendingNewChat: null,
		// 待发送的「当前论文 PDF」：用户点按钮时面板还没挂载，挂起等 onRender 补发
		pendingPdf: null,
		// 补发泵的重试计数（面板长时间不挂载时用来收手）
		pdfPumpTries: 0,
		// 发送进行中的防重入标记（zscSendPdf 入口处设置/清理）
		pdfBusy: false,
		// 主窗口文档上的"点插件图标"监听（退出时逐个摘掉）
		paneWatchers: [],
		pendingStatus: null,
		styleNodes: new Map(),
		httpLogs: 0,
	};
	// 记录启动时实际生效的服务，后面用它判断"是否真的切换了"
	ZSC.lastProvider = zscProv().id;

	// 1. 右侧栏 section
	registerSection();

	// 2. 阅读器划词 / 工具栏 / 右键菜单
	registerReaderIntegration();

	// 3. 条目右键菜单
	registerMenus();

	// 3.5 暴露给偏好面板 / 外部的接口
	try {
		Zotero.ZoteroChatGPTSidebar = {
			initPrefPane: zscInitPrefPane,
			openPanel: zscOpenPanel,
			open: zscEnsureVisible,
			ask: zscAsk,
			state: zscGetPanelState,
		};
	}
	catch (e) {
		zscError(e);
	}

	// 4. 浏览器偏好设置面板
	try {
		Zotero.PreferencePanes.register({
			pluginID: ZSC_ID,
			src: "content/prefs.xhtml",
			label: "AI 侧边栏",
			image: zscIconURL("section-20.svg", rootURI),
		});
	}
	catch (e) {
		zscError(e);
	}

	// 5. 响应头处理（让 chatgpt.com 能在侧边栏 iframe 中显示）
	startHttpObserver();

	// 6. 已打开的窗口
	if (reason !== APP_SHUTDOWN) {
		for (let win of Zotero.getMainWindows()) {
			try {
				onMainWindowLoad({ window: win }, reason);
			}
			catch (e) {
				zscError(e);
			}
		}
	}

	ZSC.ready = true;
	zscLog("startup done " + version);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	try {
		stopHttpObserver();
	}
	catch (e) { /* ignore */ }

	try {
		zscCloseProviderMenu();
	}
	catch (e) { /* ignore */ }

	try {
		for (let [type, handler] of (ZSC?.readerHandlers || [])) {
			Zotero.Reader.unregisterEventListener(type, handler);
		}
	}
	catch (e) { /* ignore */ }

	try {
		if (ZSC?.menuID) {
			Zotero.MenuManager.unregisterMenu(ZSC.menuID);
		}
	}
	catch (e) { /* ignore */ }

	try {
		for (let win of Zotero.getMainWindows()) {
			onMainWindowUnload({ window: win }, reason);
		}
	}
	catch (e) { /* ignore */ }

	try {
		if (ZSC?.sectionID) {
			Zotero.ItemPaneManager.unregisterSection(ZSC.sectionID);
		}
	}
	catch (e) { /* ignore */ }

	ZSC = null;
	zscLog("shutdown");
}

function uninstall(data, reason) {
	zscLog("uninstall");
}

function onMainWindowLoad({ window }, reason) {
	if (!window || !ZSC) {
		return;
	}
	try {
		if (ZSC.windows.has(window)) {
			return;
		}
		ZSC.windows.add(window);
	}
	catch (e) { /* WeakSet add on non-object */ }

	let doc = window.document;
	try {
		if (window.MozXULElement?.insertFTLIfNeeded) {
			window.MozXULElement.insertFTLIfNeeded("zoterogpt.ftl");
		}
	}
	catch (e) {
		zscError(e);
	}
	injectWindowStyle(window, doc);

	// 「点开插件」= 点右侧栏图标条上我们那一格；捕获阶段委托，文库页/阅读器都覆盖
	try {
		doc.addEventListener("click", zscOnPaneButtonClick, true);
		ZSC.paneWatchers.push([doc, zscOnPaneButtonClick]);
	}
	catch (e) {
		zscError(e);
	}
}

function onMainWindowUnload({ window }, reason) {
	if (!window || !ZSC) {
		return;
	}
	let doc = window.document;
	try {
		let style = doc.getElementById("zsc-window-style");
		if (style) {
			style.remove();
		}
	}
	catch (e) { /* ignore */ }
	try {
		let ftl = doc.querySelector('link[href="zoterogpt.ftl"]');
		if (ftl) {
			ftl.remove();
		}
	}
	catch (e) { /* ignore */ }

	// 清理"点插件图标"监听
	try {
		for (let entry of (ZSC?.paneWatchers || [])) {
			if (entry && entry[0] === doc) {
				doc.removeEventListener("click", entry[1], true);
				entry[0] = null;
			}
		}
		if (ZSC) {
			ZSC.paneWatchers = (ZSC.paneWatchers || []).filter((entry) => entry && entry[0]);
		}
	}
	catch (e) { /* ignore */ }

	// 清理拖拽监听
	try {
		window.removeEventListener("mousemove", zscOnResizeMove, true);
		window.removeEventListener("mouseup", zscOnResizeUp, true);
	}
	catch (e) { /* ignore */ }
	// 清理填充高度的 resize 监听
	zscRemoveFillListener();
}

function injectWindowStyle(window, doc) {
	try {
		if (doc.getElementById("zsc-window-style")) {
			return;
		}
		let style = doc.createElementNS(XHTML_NS, "style");
		style.id = "zsc-window-style";
		style.textContent = ZSC_PANEL_CSS;
		(doc.documentElement || doc.body).appendChild(style);
	}
	catch (e) {
		zscError(e);
	}
}

/* ------------------------------------------------------------------ */
/* 内嵌浏览器：创建 / UA / 诊断                                        */
/* ------------------------------------------------------------------ */

const ZSC_FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

/**
 * 用 Zotero 官方方式创建 <browser>（必须在 XUL 文档里用 createXULElement，
 * 否则得到的是普通未知元素，不会渲染任何内容）。
 */
function zscCreateBrowser(doc) {
	let browser = null;
	try {
		browser = doc.createXULElement("browser");
	}
	catch (e) {
		zscLog("createXULElement(browser) failed: " + e);
	}
	if (!browser) {
		try {
			let frag = doc.defaultView.MozXULElement.parseXULToFragment("<browser/>");
			browser = frag.firstElementChild;
		}
		catch (e) {
			zscError(e);
			return null;
		}
	}
	browser.id = "zsc-browser";
	browser.setAttribute("type", "content");
	browser.setAttribute("remote", "true");
	browser.setAttribute("maychangeremoteness", "true");
	browser.setAttribute("flex", "1");
	browser.setAttribute("disablehistory", "false");
	browser.setAttribute("autoscroll", "false");
	browser.setAttribute("nodefaultsrc", "true");
	try {
		let tooltip = doc.documentElement && doc.documentElement.getAttribute("tooltip");
		if (tooltip) {
			browser.setAttribute("tooltip", tooltip);
		}
	}
	catch (e) { /* ignore */ }
	browser.setAttribute("style",
		"width:100%;height:100%;min-height:180px;flex:1 1 auto;border:0;margin:0;");
	zscLog("browser created: ns=" + browser.namespaceURI + " tag=" + browser.localName);
	return browser;
}

/* ------------------------------------------------------------------ */
/* 缩放                                                                */
/* ------------------------------------------------------------------ */

const ZSC_ZOOM_MIN = 0.5;
const ZSC_ZOOM_MAX = 2.0;
const ZSC_ZOOM_STEP = 0.1;

/**
 * 缩放百分比（整数，50–200）的 pref 读写。
 *
 * **坑**：`Zotero.Prefs.set()` 在 pref 还不存在时只接受 boolean / string / 整数
 * （源码 `xpcom/prefs.js`：新建分支里只有 `parseInt(value) == value` 才 setIntPref，
 * 其余一律 throw "Invalid preference value"）。早先存的是 0.85 这种浮点，
 * 于是每次点 A+ 都在写 pref 那步抛错、缩放永远停在默认值 —— 表现就是"点了没反应"。
 * 所以这里一律按**整数百分比**存（`zoomPercent` = 85）。
 */
function zscGetZoomPercent() {
	let pct = parseInt(zscGetPref("zoomPercent", 0), 10);
	if (!pct || isNaN(pct)) {
		// 兼容旧版本留下的浮点 pref
		let legacy = parseFloat(zscGetPref("zoom", 0));
		pct = (!legacy || isNaN(legacy)) ? 85 : Math.round(legacy * 100);
	}
	return Math.min(200, Math.max(50, pct));
}

function zscSetZoomPercent(pct) {
	let v = Math.min(200, Math.max(50, parseInt(pct, 10) || 100));
	try {
		zscSetPref("zoomPercent", v);
		if (parseInt(zscGetPref("zoomPercent", 0), 10) === v) {
			return true;
		}
	}
	catch (e) {
		zscError(e);
	}
	// 兜底：直接写 Mozilla 的真实 pref 分支（Zotero 的插件 API 加了前缀）
	try {
		let key = ZSC_PREF_BRANCH + "zoomPercent";
		Services.prefs.setIntPref(key, v);
		zscLog("zoom pref written via Services.prefs: " + key + "=" + v);
		return true;
	}
	catch (e) {
		zscError(e);
	}
	return false;
}

function zscGetZoom() {
	return zscGetZoomPercent() / 100;
}

/** 缩放百分比文本：0.85 → "85%" */
function zscZoomPercent(zoom) {
	let v = (zoom === undefined || zoom === null) ? zscGetZoom() : zoom;
	return Math.round(v * 100) + "%";
}

/**
 * 设定缩放并立即生效。
 * 写 pref（跨会话记住）→ 应用到所有内嵌浏览器 → 面板底部提示行显示当前百分比，
 * 不弹系统小窗（连续点 A+ 时那个窗很烦）。
 */
function zscZoomSet(value) {
	let zoom = parseFloat(value);
	if (!zoom || isNaN(zoom)) {
		zoom = 1;
	}
	zoom = Math.min(ZSC_ZOOM_MAX, Math.max(ZSC_ZOOM_MIN, zoom));
	let pct = Math.round(zoom * 100);
	zscSetZoomPercent(pct);
	zoom = zscGetZoom();
	let applied = zscApplyZoom();
	let msg = (zscIsZh() ? "缩放 " : "Zoom ") + zscZoomPercent(zoom);
	if (!applied) {
		msg = zscIsZh()
			? "缩放未生效（当前 Zotero 不支持内嵌页缩放）"
			: "Zoom not supported in this Zotero build";
	}
	zscSetStatus(msg);
	zscNotifyZoomListeners();
	return zoom;
}

/** 相对当前值迈一步（A− / A+ 按钮用） */
function zscZoomStep(delta) {
	return zscZoomSet(zscGetZoom() + delta);
}

/** 让已打开的设置窗口跟着刷新百分比（改完立刻看得见） */
function zscNotifyZoomListeners() {
	let list = ZSC && ZSC.zoomListeners;
	if (!list || !list.length) {
		return;
	}
	for (let item of list) {
		try {
			if (item && item.win && item.win.closed) {
				continue;
			}
			let fn = item && item.fn ? item.fn : item;
			fn();
		}
		catch (e) { /* ignore */ }
	}
}

/** 我们自己的全部内嵌浏览器：右侧栏面板 + 用「在标签页中打开」开出来的那些 */
function zscZoomTargets() {
	let out = [];
	if (ZSC && ZSC.panel && ZSC.panel.browser) {
		out.push(ZSC.panel.browser);
	}
	if (ZSC && ZSC.tabBrowsers && ZSC.tabBrowsers.length) {
		out = out.concat(ZSC.tabBrowsers);
	}
	return out;
}

/**
 * 对单个浏览器设置缩放，并**读回校验**。
 *
 * 三条通道都试：Zotero 10 用的是 `browser-custom-element`（自定义元素），
 * 它未必实现 `fullZoom` —— 直接 `browser.fullZoom = x` 可能只是给元素加了个
 * 普通 JS 属性（不报错、也不生效）。所以以 browsingContext 为主，docShell 次之，
 * 元素属性放最后，最后按读回值判断到底成没成。
 */
function zscZoomApplyTo(browser, zoom) {
	if (!browser) {
		return null;
	}
	let how = [];
	try {
		let bc = browser.browsingContext;
		if (bc) {
			bc.fullZoom = zoom;
			how.push("bc=" + (Math.abs(bc.fullZoom - zoom) < 0.001 ? "ok" : "got" + bc.fullZoom));
		}
	}
	catch (e) {
		how.push("bc:X(" + e.name + ")");
	}
	if (!how.length || how[0].indexOf("ok") === -1) {
		try {
			if (browser.docShell) {
				browser.docShell.fullZoom = zoom;
				how.push("ds");
			}
		}
		catch (e) {
			how.push("ds:X");
		}
	}
	try {
		browser.fullZoom = zoom;
		if (browser.fullZoom === zoom) {
			how.push("el");
		}
	}
	catch (e) { /* ignore */ }
	return how.join(",");
}

/** 给内嵌网页设置缩放（铺满窄侧边栏 / 放大字体用）；返回是否真的生效 */
function zscApplyZoom(browser) {
	let zoom = zscGetZoom();
	let all = browser ? [browser] : zscZoomTargets();
	let applied = false;
	let notes = [];
	for (let br of all) {
		let how = zscZoomApplyTo(br, zoom);
		if (how && (how.indexOf("ok") !== -1 || how.indexOf("ds") !== -1)) {
			applied = true;
		}
		notes.push(how || "(none)");
	}
	zscLog("zoom=" + zscZoomPercent(zoom) + " targets=" + all.length + " [" + notes.join(" | ") + "]"
		+ (applied ? "" : " NOT-APPLIED"));
	return all.length ? applied : false;
}

/* ------------------------------------------------------------------ */
/* 把文字直接送进 ChatGPT 当前对话                                     */
/* ------------------------------------------------------------------ */

/**
 * 伪 translator 的 JSON 表头。
 *
 * 文字注入和 PDF 注入走的是同一套 RemoteTranslate 通道，表头必须一致；
 * PDF 分多步注入，每步换一个 translatorID（避免命中上一次的代码缓存）。
 */
function zscTranslatorHeader(label, translatorID) {
	return [
		'{',
		'\t"translatorID": "' + (translatorID || ZSC_INJECT_ID) + '",',
		'\t"label": "' + label + '",',
		'\t"creator": "Zotero ChatGPT Sidebar",',
		'\t"target": "^https?://",',
		'\t"minVersion": "5.0",',
		'\t"maxVersion": "",',
		'\t"priority": 0,',
		'\t"inRepository": false,',
		'\t"translatorType": 4,',
		'\t"browserSupport": "gcsibv",',
		'\t"lastUpdated": "2026-09-21 00:00:00"',
		'}',
		'',
	];
}

/**
 * 生成一段在 chatgpt.com 页面里执行的脚本。
 *
 * 为什么要绕这么大一圈：内嵌网页跑在独立的内容进程里，插件在父进程拿不到它的
 * DOM（remote browser 的 contentWindow 为空）。Zotero 自己的 `RemoteTranslate`
 * 是官方提供的"在远程网页里执行 JS"的通道——它把翻译框架连同我们给的
 * translator 代码一起注入网页，代码里就能直接操作该页 DOM。
 */
function zscInjectCode(text) {
	let prov = zscProv();
	return zscTranslatorHeader("Zotero AI Sidebar - Inject").concat([
		'function detectWeb(doc, url) { return "webpage"; }',
		'',
		'function doWeb(doc, url) {',
		'	var say = function (m) { try { Zotero.debug("ZSC:" + m); } catch (e) {} };',
		'	var W = doc.defaultView;',
		'	var sleep = function (ms) { return new Promise(function (r) { W.setTimeout(r, ms); }); };',
		'	var COMPOSER_SEL = ' + JSON.stringify(prov.composer) + ';',
		'	var SEND_SEL = ' + JSON.stringify(prov.send) + ';',
		'	var PREFER_ENTER = ' + JSON.stringify(!!prov.preferEnter) + ';',
		// noWait：派发完发送动作就返回，不等结果。DeepSeek 必须这样——
		// 它在首页发出第一条消息时会整页跳到 /a/chat/s/...，window global 一换，
		// Zotero 的 translator actor 立刻销毁，任何还在挂起的 await 都会以
		// "Actor 'Translation' destroyed" 被 reject，于是被误判成发送失败。
		'	var NO_WAIT = ' + JSON.stringify(!!prov.noWait) + ';',
		'',
		'	var isVisible = function (el) {',
		'		try {',
		'			var r = el.getBoundingClientRect();',
		'			if (!r || r.width < 2 || r.height < 2) { return false; }',
		'			var st = W.getComputedStyle(el);',
		'			if (st && (st.visibility === "hidden" || st.display === "none" || st.opacity === "0")) { return false; }',
		'			return true;',
		'		}',
		'		catch (e) { return true; }',
		'	};',
		'',
		'	var findComposer = function () {',
		'		for (var i = 0; i < COMPOSER_SEL.length; i++) {',
		'			var list = [];',
		'			try { list = Array.prototype.slice.call(doc.querySelectorAll(COMPOSER_SEL[i])); } catch (e) {}',
		'			for (var j = 0; j < list.length; j++) {',
		'				if (isVisible(list[j])) { return list[j]; }',
		'			}',
		'		}',
		'		return null;',
		'	};',
		'',
		'	var findSend = function () {',
		'		for (var i = 0; i < SEND_SEL.length; i++) {',
		'			var list = [];',
		'			try { list = Array.prototype.slice.call(doc.querySelectorAll(SEND_SEL[i])); } catch (e) {}',
		'			for (var j = list.length - 1; j >= 0; j--) {',
		'				var el = list[j];',
		'				if (!el || el.disabled) { continue; }',
		'				if (String(el.getAttribute("aria-disabled") || "") === "true") { continue; }',
		'				return el;',
		'			}',
		'		}',
		'		return null;',
		'	};',
		'',
		'	var usable = function (b) {',
		'		if (!b) { return false; }',
		'		try { return !(b.disabled || String(b.getAttribute("aria-disabled") || "") === "true"); }',
		'		catch (e) { return true; }',
		'	};',
		'',
		// 发送键位置启发式：DeepSeek 的发送按钮没有 aria-label、class 是随机哈希，
		// 只能靠"在输入框附近的容器里、尺寸像图标按钮、位置最靠右下"来认。
		// 必须排掉「深度思考 / 联网搜索 / 上传附件」这些开关——误点它们会改掉对话设置。
		'	var BAD_LABEL = ["深度思考", "联网搜索", "上传", "附件", "语音", "文件", "思考", "搜索"];',
		'	var labelBad = function (b) {',
		'		var s = "";',
		'		try { s = String(b.getAttribute("aria-label") || "") + " " + String(b.textContent || "") + " " + String(b.getAttribute("title") || ""); }',
		'		catch (e) { return false; }',
		'		for (var i = 0; i < BAD_LABEL.length; i++) {',
		'			if (s.indexOf(BAD_LABEL[i]) !== -1) { return true; }',
		'		}',
		'		return false;',
		'	};',
		'	var findSendNear = function (ed, strict) {',
		'		var cr = null;',
		'		try { cr = ed.getBoundingClientRect(); } catch (e) {}',
		// 严格模式只认输入框中线右侧的按钮：DeepSeek 把「深度思考 / 联网搜索 / 上传」
		// 摆在工具栏左边，发送键在最右边，用这条线把功能开关挡掉，避免点错开关。
		'		var minLeft = (strict && cr) ? (cr.left + cr.width * 0.5) : -1e9;',
		'		var box = ed;',
		'		for (var up = 0; up < 6; up++) {',
		'			box = box && box.parentElement;',
		'			if (!box) { break; }',
		'			var list = [];',
		'			try { list = Array.prototype.slice.call(box.querySelectorAll(\'button, [role="button"], [type="submit"]\')); }',
		'			catch (e) { list = []; }',
		'			var best = null, bestScore = -1e15;',
		'			for (var i = 0; i < list.length; i++) {',
		'				var b = list[i];',
		'				if (b === ed) { continue; }',
		'				if (b.contains && b.contains(ed)) { continue; }',
		'				if (labelBad(b)) { continue; }',
		'				var r = null;',
		'				try { r = b.getBoundingClientRect(); } catch (e) { continue; }',
		'				if (!r || r.width < 8 || r.height < 8 || r.width > 140 || r.height > 140) { continue; }',
		'				if (r.left < minLeft) { continue; }',
		'				var lab = "";',
		'				try { lab = String(b.getAttribute("aria-label") || "") + " " + String(b.getAttribute("type") || ""); } catch (e) {}',
		// 位置权重：越靠右、越靠下越像发送键。right 权重大于 top，因为工具栏是横向一排。
		'				var score = r.left + r.top * 0.3 + (/submit|send|发送/i.test(lab) ? 900 : 0) + (usable(b) ? 0 : -4000);',
		'				if (score > bestScore) { bestScore = score; best = b; }',
		'			}',
		'			if (best) { return best; }',
		'		}',
		'		return null;',
		'	};',
		'',
		'	var val = function (el) {',
		'		try {',
		'			if (typeof el.value === "string") { return el.value; }',
		'			return el.innerText || el.textContent || "";',
		'		}',
		'		catch (e) { return ""; }',
		'	};',
		'	var isEditable = function (el) {',
		'		try { return String(el.getAttribute("contenteditable") || "").toLowerCase() === "true"; }',
		'		catch (e) { return false; }',
		'	};',
		'',
		'	// 把插入点放到输入框末尾。',
		'	// 不要用 document.execCommand("selectAll")：在 contenteditable 里可能选中整页，',
		'	// 随后的 insertText 会把整个页面替换掉。',
		'	var putCaretAtEnd = function (ed) {',
		'		try {',
		'			if (isEditable(ed)) {',
		'				var sel = W.getSelection();',
		'				var range = doc.createRange();',
		'				range.selectNodeContents(ed);',
		'				range.collapse(false);',
		'				sel.removeAllRanges();',
		'				sel.addRange(range);',
		'				return true;',
		'			}',
		'			if (typeof ed.setSelectionRange === "function") {',
		'				var n = String(ed.value || "").length;',
		'				ed.setSelectionRange(n, n);',
		'				return true;',
		'			}',
		'		}',
		'		catch (e) { say("CARET_ERR " + e); }',
		'		return false;',
		'	};',
		'',
		'	// <textarea> 兜底写入：调原生 setter 再抛 input 事件，让 React 受控组件同步',
		'	var setTextareaValue = function (ed, text) {',
		'		try {',
		'			var proto = W.HTMLTextAreaElement && W.HTMLTextAreaElement.prototype;',
		'			var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");',
		'			if (desc && desc.set) { desc.set.call(ed, text); }',
		'			else { ed.value = text; }',
		'			ed.dispatchEvent(new W.Event("input", { bubbles: true }));',
		'			return true;',
		'		}',
		'		catch (e) { say("TEXTAREA_ERR " + e); return false; }',
		'	};',
		'',
		'	// contenteditable 兜底写入：整段替换 + input 事件',
		'	var setEditableValue = function (ed, text) {',
		'		try {',
		'			ed.focus();',
		'			putCaretAtEnd(ed);',
		'			var ok = doc.execCommand("insertText", false, text);',
		'			if (!ok || val(ed).indexOf(text.slice(0, 20)) === -1) {',
		'				ed.textContent = text;',
		'				ed.dispatchEvent(new W.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));',
		'			}',
		'			return true;',
		'		}',
		'		catch (e) { say("EDITABLE_ERR " + e); return false; }',
		'	};',
		'',
		// 只负责"把回车派发出去"，不等结果——等待会把本次注入拖进页面导航，
		// 导致 translator actor 被销毁（见 NO_WAIT 注释）。是否真的发出去由
		// 父进程侧看 URL 变化 / 输入框是否清空来判断。
		'	var pressEnter = function (ed) {',
		'		var o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };',
		'		try {',
		'			ed.dispatchEvent(new W.KeyboardEvent("keydown", o));',
		'			ed.dispatchEvent(new W.KeyboardEvent("keypress", o));',
		'			ed.dispatchEvent(new W.KeyboardEvent("keyup", o));',
		'			return true;',
		'		}',
		'		catch (e) { say("ENTER_ERR " + e); return false; }',
		'	};',
		'',
		'	var main = async function () {',
		'		var payload = ' + JSON.stringify(text) + ';',
		'		var probe = payload.slice(0, 40);',
		'		var ed = findComposer();',
		'		if (!ed) { say("NO_COMPOSER url=" + doc.location.href); return; }',
		'		var editable = isEditable(ed);',
		'		say("COMPOSER " + ed.tagName + " id=" + (ed.id || "-") + " editable=" + editable);',
		'		try { ed.focus(); } catch (e) {}',
		'		// 刻意不清空输入框：用户可能打了一半草稿，清掉就是数据丢失。追加到末尾，用户自行删改。',
		'		say("BEFORE len=" + String(val(ed)).length);',
		'		putCaretAtEnd(ed);',
		'		var ok = false;',
		'		try { ok = doc.execCommand("insertText", false, payload); }',
		'		catch (e) { say("EXEC_ERR " + e); }',
		'		if (!ok || String(val(ed)).indexOf(probe) === -1) {',
		'			say("EXEC_FALLBACK");',
		'			if (editable) { setEditableValue(ed, payload); }',
		'			else { setTextareaValue(ed, payload); }',
		'		}',
		'		if (String(val(ed)).indexOf(probe) === -1) {',
		'			say("INSERT_FAILED nowlen=" + String(val(ed)).length);',
		'			return;',
		'		}',
		'		say("INSERTED len=" + payload.length);',
		'',
		'		if (NO_WAIT) {',
		'			// 快路径：找按钮 → 点它；按钮不可用就回车。派发完立刻返回，不 await。',
		'			var nb = findSend();',
		'			if (!usable(nb)) { nb = findSendNear(ed, true); }',
		'			if (!usable(nb)) { nb = findSendNear(ed, false); }',
		'			if (!usable(nb)) { nb = null; }',
		'			var how = "";',
		'			if (nb) {',
		'				try {',
		'					say("SEND_BTN " + nb.tagName + " aria=" + (nb.getAttribute("aria-label") || "-"));',
		'					nb.click();',
		'					how = "BUTTON";',
		'				}',
		'				catch (e) { say("CLICK_ERR " + e); }',
		'			}',
		'			if (!how && pressEnter(ed)) { how = "ENTER"; }',
		'			if (!how) { say("DISPATCH_FAILED btn=" + (nb ? "y" : "n")); return; }',
		'			say("DISPATCHED_" + how);',
		'			return;',
		'		}',
		'',
		'		// 等 React 把状态刷完、发送按钮从禁用变可用',
		'		var btn = null;',
		'		for (var i = 0; i < 30; i++) {',
		'			await sleep(100);',
		'			btn = findSend();',
		'			if (btn) { break; }',
		'		}',
		'',
		'		if (PREFER_ENTER) {',
		'			say("TRY_ENTER");',
		'			if (pressEnter(ed)) { say("SENT_ENTER"); return; }',
		'		}',
		'		if (btn) {',
		'			try {',
		'				btn.click();',
		'				await sleep(400);',
		'				if (String(val(ed)).length === 0) { say("SENT_BUTTON"); return; }',
		'				// 输入框还有内容：可能 React 还没清空。再等 1.2s 二次确认，',
		'				// 避免"其实已发出"时又补回车造成重复发送。',
		'				await sleep(1200);',
		'				if (String(val(ed)).length === 0) { say("SENT_BUTTON_SLOW"); return; }',
		'				say("SENT_BUTTON_UNCLEAR len=" + String(val(ed)).length);',
		'			}',
		'			catch (e) { say("CLICK_ERR " + e); }',
		'		}',
		'		if (PREFER_ENTER) {',
		'			say("SENT_UNCLEAR len=" + String(val(ed)).length);',
		'			return;',
		'		}',
		'		try {',
		'			if (pressEnter(ed)) { say("SENT_ENTER"); return; }',
		'			say("SENT_ENTER_UNCLEAR len=" + String(val(ed)).length);',
		'		}',
		'		catch (e) { say("ENTER_ERR " + e); }',
		'	};',
		'',
		'	return main().then(function () { return []; }, function (e) { say("MAIN_ERR " + e); return []; });',
		'}',
	]).join("\n");
}

/**
 * 页面回传消息归一化。
 *
 * 页面里写的是 `Zotero.debug("ZSC:" + msg)`，这条字符串会**原样**经
 * Translate.Base#_debug → 子进程 `_sendQuerySafe("Translate:runHandler")`
 * → 父进程 `TranslationManager.runHandler("debug", arg)` 回到这里，
 * 前缀不会被任何一层剥掉。所以 `m.indexOf("SENT_") === 0` 这类前缀判断
 * 必须先把 "ZSC:" 去掉，否则一律匹配不上——表现为"明明发进输入框了却报发送失败"。
 */
function zscNormMsg(msg) {
	let s = String(msg === undefined || msg === null ? "" : msg);
	if (s.indexOf("ZSC:") === 0) {
		s = s.slice(4);
	}
	return s;
}

/**
 * 面板当前是否停在 ChatGPT 页面上（否则不值得尝试注入）。
 *
 * `ignoreLoading: true` 时只判 URL、不看加载状态。这是必需的：面板刚被
 * 重新挂载、或刚导航到某个对话页时，`currentURI` 已经是那个对话、
 * 但 `loaded` 还是 false。老代码这时判定为"不在 ChatGPT 页" → 走
 * zscSendPrompt → 导航到 `?q=` → **把用户正看的对话顶成新对话**。
 * 正确做法是把它当成"要等它加载"，而不是"要新开一个"。
 */
function zscPanelOnChat(options) {
	options = options || {};
	let panel = ZSC && ZSC.panel;
	if (!panel || !panel.browser) {
		return false;
	}
	if (!options.ignoreLoading && !panel.loaded) {
		return false;
	}
	try {
		let spec = panel.browser.currentURI && panel.browser.currentURI.spec || "";
		let host = "";
		try {
			host = panel.browser.currentURI.host || "";
		}
		catch (e) { /* ignore */ }
		if (!host) {
			let m = String(spec).match(/^https?:\/\/([^\/:]+)/i);
			host = m ? m[1] : "";
		}
		return zscHostIn(host, zscProv().hosts);
	}
	catch (e) {
		return false;
	}
}

/** 面板不仅停在 ChatGPT 页，而且文档已经加载完（可以尝试注入了） */
function zscPanelPageReady() {
	if (!zscPanelOnChat({ ignoreLoading: true })) {
		return false;
	}
	try {
		let wp = ZSC.panel.browser.webProgress;
		if (wp && wp.isLoadingDocument) {
			return false;
		}
	}
	catch (e) { /* ignore */ }
	return true;
}

/** 注入失败信息是否属于"再等等可能就好了"（页面 / 输入框还没就绪） */
function zscInjectRetriable(messages) {
	return (messages || []).some(m =>
		m.indexOf("NO_COMPOSER") === 0
		|| m.indexOf("detect-empty") === 0
		|| m.indexOf("no-window-global") === 0
		|| m.indexOf("INSERT_FAILED") === 0
		|| m.indexOf("EXEC_FALLBACK") === 0);
}

/**
 * 把"划词时面板还没就绪"而暂存的内容，送进面板**当前显示的对话**。
 *
 * 为什么要轮询等待：刚挂载出来的浏览器还在加载 ChatGPT（SPA，输入框要等
 * React 渲染完才有），这时注入必然拿到 NO_COMPOSER。所以先等页面加载完，
 * 页面在但输入框还没出来也再试几轮。
 *
 * 全程**不做任何导航**——宁可退回剪贴板，也绝不把用户正在看的对话换成新对话。
 */
async function zscDeliverPrompt(content) {
	let zh = zscIsZh();
	let attempts = 6;
	for (let i = 0; i < attempts; i++) {
		if (!ZSC.panel || !ZSC.panel.browser) {
			break;
		}
		if (zscPanelPageReady()) {
			let res = await zscInjectIntoPage(content);
			if (res.ok) {
				let msg = res.confirmed ? zscT("sentCurrent") : zscT("sentUnclear");
				zscSetStatus(msg);
				if (zscGetPref("toastOnSend", true)) {
					zscToast(Zotero.getMainWindow(), msg);
				}
				return;
			}
			// 页面在、但输入框还没渲染出来（或注入时机太早）→ 再等一轮；其他错误不必重试
			if (!zscInjectRetriable(res.messages)) {
				break;
			}
		}
		await Zotero.Promise.delay(1800);
	}
	// 等不到就退回剪贴板，并说清"没有动你的对话"
	let msg = zh
		? "侧边栏还没准备好，内容已复制到剪贴板（没有新开对话）"
		: "Sidebar wasn't ready — copied to clipboard (no new chat was opened)";
	zscCopyToClipboard(content);
	zscSetStatus(msg);
	zscShowDiag("[deliver] " + (zh ? "侧边栏未就绪" : "sidebar not ready"));
	if (zscGetPref("toastOnSend", true)) {
		zscToast(Zotero.getMainWindow(), msg);
	}
}

/**
 * 在内嵌网页里插入文本并提交，返回 { ok, messages }。
 * 全程 try/catch + 超时，失败时由调用方兜底到"新对话"。
 */
async function zscInjectIntoPage(text) {
	let browser = ZSC && ZSC.panel && ZSC.panel.browser;
	if (!browser || !browser.browsingContext || !browser.browsingContext.currentWindowGlobal) {
		return { ok: false, messages: ["no-window-global"] };
	}
	let urlBefore = "";
	try {
		urlBefore = browser.currentURI && browser.currentURI.spec || "";
	}
	catch (e) { /* ignore */ }
	let messages = [];
	let remote = null;
	try {
		let { RemoteTranslate } = ChromeUtils.importESModule("chrome://zotero/content/RemoteTranslate.mjs");
		remote = new RemoteTranslate({ disableErrorReporting: true });
		await remote.setBrowser(browser);
		remote.setHandler("debug", (_, msg) => messages.push(zscNormMsg(msg)));
		remote.setHandler("error", (_, msg) => messages.push("ERR " + msg));
		remote.setTranslator({
			translatorID: ZSC_INJECT_ID,
			label: "Zotero ChatGPT Inject",
			creator: "Zotero ChatGPT Sidebar",
			priority: 0,
			translatorType: 4,
			browserSupport: "gcsibv",
			target: "^https?://",
			// 必须显式给 runMode = 1（RUN_MODE_IN_BROWSER）。
			// Zotero 的 Translate.Web 靠这个字段判断"该在页面里跑"还是"该发 RPC"：
			// 我们传的是普通对象、没经过 Zotero.Translator 构造函数，不写就等于 undefined，
			// detect() 会直接返回空、doWeb 永远不执行（这正是之前"点了没反应"的根因）。
			runMode: 1,
			lastUpdated: "2026-09-21 00:00:00",
			code: zscInjectCode(text),
		});
		let detected = await remote.detect();
		if (!detected || !detected.length) {
			messages.push("detect-empty");
		}
		else {
			await Promise.race([
				remote.translate({ libraryID: false }),
				Zotero.Promise.delay(15000).then(() => messages.push("translate-timeout")),
			]);
		}
	}
	catch (e) {
		messages.push("EXC " + (e && e.message ? e.message : e));
	}
	finally {
		try {
			if (remote) {
				remote.dispose();
			}
		}
		catch (e) { /* ignore */ }
	}
	let urlAfter = "";
	try {
		urlAfter = browser.currentURI && browser.currentURI.spec || "";
	}
	catch (e) { /* ignore */ }
	// 页内已经派发发送动作、随后页面整页跳走（DeepSeek 首页发第一条就是这种），
	// actor 会被销毁并让 translate() reject。这属于"动作已生效"，不是失败。
	let dispatched = messages.some(m => m.indexOf("DISPATCHED_") === 0);
	let navigated = !!(urlBefore && urlAfter && urlBefore !== urlAfter);
	if (dispatched && navigated) {
		messages.push("NAVIGATED_AFTER_SEND");
	}
	zscLog("inject: " + (messages.length ? messages.join(" | ") : "(no messages)")
		+ " | url=" + (urlBefore || "-") + " -> " + (urlAfter || "-"));
	// ok        = 发送动作已经派发出去（或输入框被清空确认发出）
	// confirmed = 有确凿证据说明消息真的送出去了
	let sentConfirmed = messages.some(m => m.indexOf("SENT_") === 0 && m.indexOf("UNCLEAR") === -1);
	let ok = dispatched || messages.some(m => m.indexOf("SENT_") === 0);
	// noWait 的站点（DeepSeek）在已有会话里发消息不会改 URL，没法靠跳转确认；
	// 但"按钮已点/回车已发"就是它能给的最强保证，按已发送处理，别拿"没确认"去烦用户。
	let confirmed = sentConfirmed || (dispatched && (navigated || !!zscProv().noWait));
	return { ok: ok, confirmed: confirmed, messages: messages };
}

/* ------------------------------------------------------------------ */
/* 把当前论文的 PDF 送进对话                                            */
/* ------------------------------------------------------------------ */
/*
 * 难在哪：面板里的 chatgpt.com 跑在独立内容进程里，插件在父进程既拿不到它的
 * DOM，也不可能把一个 File 对象直接塞过去。唯一验证过的通道是 Zotero 的
 * RemoteTranslate —— 它能把一段 translator 代码注入页面里执行。于是分两路：
 *
 *   1) 直读（优先）：注入的脚本用沙箱里那个"系统级 XMLHttpRequest"
 *      （RemoteTranslate 建沙箱时注入了 wantGlobalProperties: XMLHttpRequest/fetch）
 *      去读 file:// —— 这是整个链路里唯一能碰本地文件的地方。成功就一步到位，
 *      几十 MB 也不怕。
 *   2) 分片（兜底）：父进程把 PDF 读进内存 → 按 45 万字节切片 → base64 随注入
 *      代码一片片送进页面 → 页面 atob 拼回 Uint8Array。慢，但只依赖已验证的通道。
 *
 * 字节到手后：挑一个 input[type=file] → 用 DataTransfer 造 FileList → 派发 change。
 * ChatGPT 收到就会上传并把文件卡片挂到输入框上（不会自动发送，用户自己按回车）。
 */

/** 父进程侧 base64 编码（自己写，避免依赖 btoa 在 bootstrap 域里存不存在） */
function zscB64Encode(bytes, start, end) {
	const T = ZSC_B64_TABLE;
	const step = 3 * 4096; // 每次 12288 字节：3 的倍数，分块边界不会破坏编码
	let out = [];
	for (let i = start; i < end; i += step) {
		let stop = Math.min(i + step, end);
		let s = "";
		let j = i;
		for (; j + 2 < stop; j += 3) {
			let b0 = bytes[j], b1 = bytes[j + 1], b2 = bytes[j + 2];
			s += T[b0 >> 2] + T[((b0 & 3) << 4) | (b1 >> 4)]
				+ T[((b1 & 15) << 2) | (b2 >> 6)] + T[b2 & 63];
		}
		let rest = stop - j;
		if (rest === 1) {
			let b0 = bytes[j];
			s += T[b0 >> 2] + T[(b0 & 3) << 4] + "==";
		}
		else if (rest === 2) {
			let b0 = bytes[j], b1 = bytes[j + 1];
			s += T[b0 >> 2] + T[((b0 & 3) << 4) | (b1 >> 4)] + T[(b1 & 15) << 2] + "=";
		}
		out.push(s);
	}
	return out.join("");
}

/** 注入脚本里通用的几个小工具（状态读写、PDF 魔数校验、分片拼接、找输入框、附加文件） */
function zscPagePrelude() {
	return [
		'var ZSC_SAY = function (m) { try { Zotero.debug("ZSC:" + m); } catch (e) {} };',
		'var ZSC_STATE_KEY = "__zscPdf";',
		'var ZSC_COMPOSER_SEL = ' + JSON.stringify(zscProv().composer) + ';',
		'var ZSC_FIND_COMPOSER = function (doc) {',
		'	for (var i = 0; i < ZSC_COMPOSER_SEL.length; i++) {',
		'		var el = null;',
		'		try { el = doc.querySelector(ZSC_COMPOSER_SEL[i]); } catch (e) {}',
		'		if (el) { return el; }',
		'	}',
		'	return null;',
		'};',
		'',
		'// 状态挂在页面 window 上，才能在多次注入之间保留。',
		'// 优先挂 wrappedJSObject（绕过 Xray 的原始对象，最稳），同时挂 Xray 包装对象。',
		'var ZSC_WRITE_STATE = function (doc, st) {',
		'	var w = doc.defaultView;',
		'	var ok = false;',
		'	try { var raw = w.wrappedJSObject; if (raw) { raw[ZSC_STATE_KEY] = st; ok = true; } } catch (e) {}',
		'	try { w[ZSC_STATE_KEY] = st; ok = true; } catch (e) {}',
		'	return ok;',
		'};',
		'var ZSC_READ_STATE = function (doc) {',
		'	try {',
		'		var w = doc.defaultView;',
		'		try { var raw = w.wrappedJSObject; if (raw && raw[ZSC_STATE_KEY]) { return raw[ZSC_STATE_KEY]; } } catch (e) {}',
		'		try { if (w[ZSC_STATE_KEY]) { return w[ZSC_STATE_KEY]; } } catch (e) {}',
		'	}',
		'	catch (e) {}',
		'	return null;',
		'};',
		'',
		'var ZSC_LOOKS_PDF = function (buf, W) {',
		'	try {',
		'		if (!buf || buf.byteLength < 5) { return false; }',
		'		// Zotero 10（新 Gecko）禁止沙箱代码跨 Xray 逐字节访问页面域的 TypedArray，',
'		// 必须用沙箱自己的 Uint8Array（同 realm，读写不受限）。页面域的只作最后兜底。',
'		var U8 = (typeof Uint8Array === "function") ? Uint8Array',
'			: ((W && W.wrappedJSObject && W.wrappedJSObject.Uint8Array) || (W && W.Uint8Array));',
		'		var head = new U8(buf, 0, 5);',
		'		var s = "";',
		'		for (var i = 0; i < 5; i++) { s += String.fromCharCode(head[i]); }',
		'		return s === "%PDF-";',
		'	}',
		'	catch (e) { return false; }',
		'};',
		'',
		'var ZSC_JOIN_CHUNKS = function (st, W, say) {',
		'	try {',
		'		// Zotero 10（新 Gecko）禁止沙箱代码跨 Xray 逐字节访问页面域的 TypedArray，',
'		// 必须用沙箱自己的 Uint8Array（同 realm，读写不受限）。页面域的只作最后兜底。',
'		var U8 = (typeof Uint8Array === "function") ? Uint8Array',
'			: ((W && W.wrappedJSObject && W.wrappedJSObject.Uint8Array) || (W && W.Uint8Array));',
		'		// WebIDL 方法必须以正确的 this 调用：把页面的 atob 摘出来裸调（atobFn(s)）',
		'		// 会抛 "atob called on an object that does not implement interface Window"。',
		'		// 从 wrappedJSObject（原始窗口）上取函数并 bind 回去，或直接以方法调用形式调。',
		'		var rawW = (W && W.wrappedJSObject) ? W.wrappedJSObject : W;',
		'		var atobFn = null;',
		'		try { if (rawW && typeof rawW.atob === "function") { atobFn = rawW.atob.bind(rawW); } } catch (e0) {}',
		'		if (!atobFn && typeof atob === "function") { atobFn = atob; }',
		'		if (!atobFn) { say("JOIN_NO_ATOB"); return null; }',
		'		var parts = [];',
		'		var total = 0;',
		'		for (var i = 0; i < st.chunks.length; i++) {',
		'			var s = st.chunks[i];',
		'			if (!s) { say("JOIN_MISSING " + i); return null; }',
		'			var bin = atobFn(s);',
		'			var arr = new U8(bin.length);',
		'			for (var j = 0; j < bin.length; j++) { arr[j] = bin.charCodeAt(j) & 0xff; }',
		'			parts.push(arr);',
		'			total += arr.length;',
		'		}',
		'		if (!total) { say("JOIN_EMPTY"); return null; }',
		'		var all = new U8(total);',
		'		var off = 0;',
		'		for (var k = 0; k < parts.length; k++) { all.set(parts[k], off); off += parts[k].length; }',
		'		say("JOINED bytes=" + total);',
		'		return all.buffer;',
		'	}',
		'	catch (e) { say("JOIN_ERR " + e); return null; }',
		'};',
		'',
		'// 挑一个合适的 input[type=file]：优先 accept 里带 pdf 或没写 accept 的，排除纯图片的',
		'var ZSC_PICK_INPUT = function (inputs, say) {',
		'	var best = null, bestScore = -1;',
		'	for (var i = 0; i < inputs.length; i++) {',
		'		var el = inputs[i];',
		'		var acc = "";',
		'		try { acc = String(el.getAttribute("accept") || ""); } catch (e) {}',
		'		var score;',
		'		if (/pdf/i.test(acc)) { score = 4; }',
		'		else if (acc === "") { score = 3; }',
		'		else if (/image\\//i.test(acc) && acc.replace(/image\\/[^,]+/g, "").replace(/[\\s,]/g, "") === "") { score = 0; }',
		'		else { score = 1; }',
		'		say("INPUT[" + i + "] accept=" + (acc || "-") + " score=" + score);',
		'		if (score > bestScore) { bestScore = score; best = el; }',
		'	}',
		'	return best;',
		'};',
		'',
		'// 粗略确认文件卡片是否挂上去了（只看输入框附近，避免把对话正文里的同名文字算进来）',
		'var ZSC_VERIFY = function (doc, name) {',
		'	try {',
		'		var stem = String(name || "").replace(/\\.[a-z0-9]+$/i, "");',
		'		var node = ZSC_FIND_COMPOSER(doc)',
		'			|| doc.querySelector("div.ProseMirror[contenteditable=\\"true\\"]");',
		'		var scope = null;',
		'		if (node) {',
		'			try { scope = node.closest("form"); } catch (e) {}',
		'			var up = node;',
		'			for (var i = 0; !scope && i < 4 && up && up.parentElement; i++) { up = up.parentElement; }',
		'			if (!scope) { scope = up; }',
		'		}',
		'		if (!scope) { scope = doc.body; }',
		'		var txt = (scope && scope.textContent) ? scope.textContent : "";',
		'		if (stem && stem.length > 3 && txt.indexOf(stem) !== -1) { return true; }',
		'		var sels = ["[data-testid*=\\"attachment\\"]", "[data-testid*=\\"file\\"]",',
		'			"[class*=\\"attachment\\"]", "img[alt*=\\".pdf\\"]"];',
		'		for (var k = 0; k < sels.length; k++) {',
		'			try { if (scope.querySelector(sels[k])) { return true; } } catch (e) {}',
		'		}',
		'	}',
		'	catch (e) {}',
		'	return false;',
		'};',
		'',
		'var ZSC_ATTACH_FILE = function (doc, W, st, buf, say) {',
		'	var attached = false;',
		'	var file = null;',
		'	try { file = new W.File([buf], st.name, { type: "application/pdf" }); }',
		'	catch (e) { say("FILE_ERR " + e); }',
		'	if (!file) { return false; }',
		'	say("FILE ok name=" + file.name + " size=" + file.size);',
		'	var inputs = [];',
		'	try { inputs = Array.prototype.slice.call(doc.querySelectorAll("input[type=file]")); }',
		'	catch (e) {}',
		'	say("INPUTS " + inputs.length);',
		'	try {',
		'		var pick = ZSC_PICK_INPUT(inputs, say);',
		'		if (pick) {',
		'			var dt = new W.DataTransfer();',
		'			try { dt.items.add(file); } catch (e) { say("DT_ERR " + e); }',
		'			try {',
		'				pick.files = dt.files;',
		'				if (pick.files && pick.files.length) {',
		'					attached = true;',
		'					pick.dispatchEvent(new W.Event("input", { bubbles: true }));',
		'					pick.dispatchEvent(new W.Event("change", { bubbles: true }));',
		'					say("CHANGE_DISPATCHED");',
		'				}',
		'			}',
		'			catch (e) { say("SET_FILES_ERR " + e); }',
		'		}',
		'	}',
		'	catch (e) { say("INPUT_ERR " + e); }',
		'	// 输入框不让写就退回"模拟拖放"（ChatGPT 支持把文件拖到输入区）',
		'	if (!attached) {',
		'		try {',
		'			var node = ZSC_FIND_COMPOSER(doc)',
		'				|| doc.querySelector("div.ProseMirror[contenteditable=\\"true\\"]")',
		'				|| doc.body;',
		'			var target = null;',
		'			try { target = node.closest("form"); } catch (e) {}',
		'			if (!target) { target = node.parentElement || doc.body; }',
		'			var dt2 = new W.DataTransfer();',
		'			dt2.items.add(file);',
		'			var names = ["dragenter", "dragover", "drop"];',
		'			for (var n = 0; n < names.length; n++) {',
		'				var ev = (typeof W.DragEvent === "function")',
		'					? new W.DragEvent(names[n], { bubbles: true, cancelable: true, dataTransfer: dt2 })',
		'					: new W.Event(names[n], { bubbles: true, cancelable: true });',
		'				target.dispatchEvent(ev);',
		'			}',
		'			attached = true;',
		'			say("DROP_DISPATCHED");',
		'		}',
		'		catch (e) { say("DROP_ERR " + e); }',
		'	}',
		'	if (!attached) { return false; }',
		'	// 等文件卡片出现再回读一次（ChatGPT 上传是异步的）',
		'	return new Promise(function (r) { W.setTimeout(r, 1800); }).then(function () {',
		'		var hit = ZSC_VERIFY(doc, st.name);',
		'		say(hit ? "ATTACHED_VERIFIED" : "ATTACHED_UNCHECKED");',
		'		return true;',
		'	});',
		'};',
		'',
	];
}

/** 第 1 步：在页面里建状态，并尝试用系统级 XHR 直读本地文件 */
function zscPdfInitCode(meta, translatorID) {
	return zscTranslatorHeader("Zotero ChatGPT Sidebar - PDF init", translatorID)
		.concat(zscPagePrelude())
		.concat([
			'function detectWeb(doc, url) { return "webpage"; }',
			'',
			'function doWeb(doc, url) {',
			'	var st = {',
			'		name: ' + JSON.stringify(meta.name) + ',',
			'		size: ' + JSON.stringify(meta.size) + ',',
			'		url: ' + JSON.stringify(meta.url) + ',',
			'		buf: null,',
			'		status: "pending",',
			'		chunks: [],',
			'		got: 0',
			'	};',
			'	if (!ZSC_WRITE_STATE(doc, st)) { ZSC_SAY("STATE_WRITE_FAILED"); return; }',
			'	ZSC_SAY("INIT name=" + st.name + " size=" + st.size);',
			'	// 沙箱里的 XMLHttpRequest 是系统级对象（RemoteTranslate 建沙箱时',
			'	// 通过 wantGlobalProperties 注入），这是唯一能读 file:// 的入口。',
			'	try {',
			'		var xhr = new XMLHttpRequest();',
			'		xhr.open("GET", st.url, true);',
			'		xhr.responseType = "arraybuffer";',
			'		xhr.timeout = 20000;',
		'		xhr.onload = function () {',
		'			try {',
		'				st.buf = (xhr.response && xhr.response.byteLength) ? xhr.response : null;',
		'				st.status = st.buf ? "file-ok" : "file-empty";',
		'				// 魔数校验必须在"缓冲区所属的 compartment"里做：xhr.response 是',
		'				// 沙箱 realm 的 ArrayBuffer，用页面窗口的 Uint8Array 去套视图会抛',
		'				// 异常（跨 compartments），之前 PROBE_BAD 的根因就在这里。',
		'				if (st.buf) {',
		'					try {',
		'						var head = new Uint8Array(st.buf, 0, 5);',
		'						var s = "";',
		'						for (var hi = 0; hi < 5; hi++) { s += String.fromCharCode(head[hi]); }',
		'						st.magic = (s === "%PDF-");',
		'					}',
		'					catch (e2) { st.magic = false; }',
		'				}',
		'			}',
		'			catch (e) { st.status = "file-empty"; }',
		'		};',
			'		xhr.onerror = function () { st.status = "file-fail"; };',
			'		xhr.onabort = function () { st.status = "file-fail"; };',
			'		xhr.ontimeout = function () { st.status = "file-timeout"; };',
			'		xhr.send();',
			'		ZSC_SAY("XHR_STARTED");',
			'	}',
			'	catch (e) { st.status = "file-throw"; ZSC_SAY("XHR_THROW " + e); }',
			'}',
	]).join("\n");
}

/** 第 2 步：问一下"直读成了没有"，没成就走分片 */
function zscPdfProbeCode(translatorID) {
	return zscTranslatorHeader("Zotero ChatGPT Sidebar - PDF probe", translatorID)
		.concat(zscPagePrelude())
		.concat([
			'function detectWeb(doc, url) { return "webpage"; }',
			'',
			'function doWeb(doc, url) {',
			'	var st = ZSC_READ_STATE(doc);',
			'	if (!st) { ZSC_SAY("PROBE_NO_STATE"); return; }',
			'	var W = doc.defaultView;',
			'	var t0 = Date.now();',
			'	var waitMore = function () {',
			'		if (st.status === "pending" && Date.now() - t0 < 6000) {',
			'			return new Promise(function (r) { W.setTimeout(r, 150); }).then(waitMore);',
			'		}',
			'	};',
		'	return Promise.resolve(waitMore()).then(function () {',
		'		var len = st.buf ? st.buf.byteLength : 0;',
		'		ZSC_SAY("PROBE status=" + st.status + " bytes=" + len + " expected=" + st.size + " magic=" + st.magic);',
		'		// 判据用 INIT 在沙箱 realm 里算好的 st.magic；这里不再对跨 compartment',
		'		// 的缓冲区建 Uint8Array 视图（必抛异常，曾把每次直读都误判成坏文件）。',
		'		if (st.status === "file-ok" && st.magic === true && len === st.size) {',
		'			ZSC_SAY("PROBE_OK");',
		'		}',
		'		else {',
		'			if (st.status === "file-ok") { ZSC_SAY("PROBE_BAD"); }',
		'			st.buf = null;',
		'		}',
		'	});',
			'}',
	]).join("\n");
}

/** 第 3 步：把一片 base64 塞进页面状态 */
function zscPdfChunkCode(index, total, b64, translatorID) {
	return zscTranslatorHeader("Zotero ChatGPT Sidebar - PDF chunk " + index, translatorID)
		.concat(zscPagePrelude())
		.concat([
			'function detectWeb(doc, url) { return "webpage"; }',
			'',
			'function doWeb(doc, url) {',
			'	var st = ZSC_READ_STATE(doc);',
			'	if (!st) { ZSC_SAY("CHUNK_NO_STATE"); return; }',
			'	st.chunks[' + index + '] = ' + JSON.stringify(b64) + ';',
			'	st.got = 0;',
			'	for (var i = 0; i < st.chunks.length; i++) { if (st.chunks[i]) { st.got++; } }',
			'	ZSC_SAY("CHUNK " + st.got + "/' + total + '");',
			'}',
	]).join("\n");
}

/** 第 4 步：拼出 File 并塞进输入框 */
function zscPdfAttachCode(translatorID) {
	return zscTranslatorHeader("Zotero ChatGPT Sidebar - PDF attach", translatorID)
		.concat(zscPagePrelude())
		.concat([
			'function detectWeb(doc, url) { return "webpage"; }',
			'',
			'function doWeb(doc, url) {',
			'	var say = ZSC_SAY;',
			'	var W = doc.defaultView;',
			'	var st = ZSC_READ_STATE(doc);',
			'	if (!st) { say("ATTACH_NO_STATE"); return; }',
			'	var buf = st.buf;',
			'	if (!buf && st.chunks && st.chunks.length) {',
			'		buf = ZSC_JOIN_CHUNKS(st, W, say);',
			'	}',
			'	if (!buf || !buf.byteLength) { say("ATTACH_NO_BYTES"); return; }',
			'	// 直读的 buf 属于沙箱 compartment，ZSC_LOOKS_PDF 在页面对它建视图必失败；',
			'	// 以 INIT 在沙箱里算好的 st.magic 为准，只对分片拼接的缓冲区做页内校验。',
			'	if (st.magic !== true && !ZSC_LOOKS_PDF(buf, W)) { say("ATTACH_NOT_PDF"); }',
			'	var res = ZSC_ATTACH_FILE(doc, W, st, buf, say);',
			'	return res && res.then ? res : null;',
			'}',
	]).join("\n");
}

/** 找"当前正在读的那篇论文"的 PDF 文件 */
function zscFindPdfAttachment(item) {
	let isPdf = (a) => {
		try {
			return !!a && typeof a.isAttachment === "function" && a.isAttachment()
				&& a.attachmentContentType === "application/pdf";
		}
		catch (e) {
			return false;
		}
	};
	try {
		if (isPdf(item)) {
			return item;
		}
	}
	catch (e) { /* ignore */ }

	let ids = [];
	try {
		ids = item.getAttachments() || [];
	}
	catch (e) { /* ignore */ }

	let cands = [];
	for (let id of ids) {
		try {
			let a = Zotero.Items.get(id);
			if (isPdf(a)) {
				cands.push(a);
			}
		}
		catch (e) { /* ignore */ }
	}
	if (!cands.length) {
		return null;
	}
	// 链接式（LINKED_URL）附件本地往往没有文件，排后面
	let rank = (a) => {
		try {
			return a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL ? 1 : 0;
		}
		catch (e) {
			return 0;
		}
	};
	cands.sort((a, b) => rank(a) - rank(b));
	return cands[0];
}

/**
 * 只解析"当前该发哪一篇论文"，不碰文件系统（读文件那步很贵，确定要发哪篇之后再读）。
 */
function zscResolvePdfItem(options) {
	options = options || {};
	let item = null;

	// 1) 阅读器事件直接告诉我们看的是哪一篇
	let itemID = options.reader && options.reader.itemID;
	// 2) 当前标签页就是阅读器
	if (!itemID) {
		try {
			let win = Zotero.getMainWindow();
			let tabID = win && win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
			let reader = (tabID && Zotero.Reader && Zotero.Reader.getByTabID)
				? Zotero.Reader.getByTabID(tabID)
				: null;
			if (reader) {
				itemID = reader.itemID;
			}
		}
		catch (e) { /* ignore */ }
	}
	if (itemID) {
		try {
			item = Zotero.Items.get(itemID);
		}
		catch (e) { /* ignore */ }
	}
	// 3) 退回到"当前选中的条目"
	if (!item) {
		let sel = options.item ? [options.item] : zscSelectedItems();
		if (sel && sel.length) {
			item = sel[0];
		}
	}
	return item || null;
}

/** 解析出要发送的 PDF：{ item, att, path, name }，找不到返回 null */
async function zscResolvePdf(options) {
	options = options || {};
	let item = zscResolvePdfItem(options);
	if (!item) {
		return null;
	}

	let att = zscFindPdfAttachment(item);
	if (!att) {
		return null;
	}
	let path = null;
	try {
		path = await att.getFilePathAsync();
	}
	catch (e) {
		zscLog("getFilePathAsync failed: " + e);
	}
	if (!path) {
		return null;
	}
	let name = "";
	try {
		// PathUtils 在插件沙箱里不一定被注入；取不到就退回字符串切分
		name = PathUtils.filename(path);
	}
	catch (e) {
		name = String(path).split(/[\\/]/).pop() || "paper.pdf";
	}
	// 真实的字节数后面以 zscReadFileBytes 读出来的长度为准：
	// Zotero 没有公开的 item.getFileSize()（那是内部函数），这里不去猜。
	return { item, att, path, name };
}

/** 读文件字节（Uint8Array） */
async function zscReadFileBytes(path) {
	try {
		if (typeof IOUtils !== "undefined" && IOUtils.read) {
			let bytes = await IOUtils.read(path);
			if (bytes && bytes.length) {
				return bytes;
			}
		}
	}
	catch (e) {
		zscLog("IOUtils.read failed: " + e);
	}
	try {
		let bin = await Zotero.File.getBinaryContentsAsync(path);
		let out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) {
			out[i] = bin.charCodeAt(i) & 0xff;
		}
		return out;
	}
	catch (e) {
		zscError(e);
	}
	return null;
}

/** 把本地路径转成 file:// URI（用 Gecko 自己的转换，Windows 盘符不会被转义坏） */
function zscPathToFileURI(path) {
	try {
		let file = Zotero.File.pathToFile(path);
		if (file) {
			return Services.io.newFileURI(file).spec;
		}
	}
	catch (e) {
		zscLog("newFileURI failed: " + e);
	}
	return "";
}

/**
 * 一次 PDF 注入会话：反复用同一个 RemoteTranslate。
 * 复用很重要——setBrowser() 会让子进程重建翻译框架沙箱，每次新建都重建太亏；
 * 而且窗口上挂的状态也要靠同一个沙箱/包装对象才能稳定读到。
 */
async function zscNewInjectSession(browser) {
	try {
		let { RemoteTranslate } = ChromeUtils.importESModule("chrome://zotero/content/RemoteTranslate.mjs");
		let remote = new RemoteTranslate({ disableErrorReporting: true });
		await remote.setBrowser(browser);
		let session = { remote, messages: [], seq: 0 };
		// 处理器只能设一次；之后每次都从 messages 里按位置切片取本轮输出
		remote.setHandler("debug", (_, msg) => session.messages.push(zscNormMsg(msg)));
		remote.setHandler("error", (_, msg) => session.messages.push("ERR " + msg));
		return session;
	}
	catch (e) {
		zscError(e);
		return null;
	}
}

async function zscSessionInject(session, code, timeoutMs) {
	session.seq++;
	let seq = session.seq;
	let start = session.messages.length;
	// 每次换一个 translatorID：避免框架按 ID 命中上一次的代码缓存
	session.remote.setTranslator({
		translatorID: ZSC_INJECT_ID + "-pdf-" + seq,
		label: "Zotero ChatGPT Sidebar - PDF step " + seq,
		creator: "Zotero ChatGPT Sidebar",
		priority: 0,
		translatorType: 4,
		browserSupport: "gcsibv",
		target: "^https?://",
		// 与文字注入同理：必须显式 runMode = 1（RUN_MODE_IN_BROWSER），
		// 否则 Translate.Web 认为"不该在页面里跑"，doWeb 永远不执行。
		runMode: 1,
		lastUpdated: "2026-09-21 00:00:00",
		code,
	});
	try {
		let detected = await session.remote.detect();
		if (!detected || !detected.length) {
			session.messages.push("PDF_STEP" + seq + " detect-empty");
		}
		else {
			await Promise.race([
				session.remote.translate({ libraryID: false }),
				Zotero.Promise.delay(timeoutMs || 25000)
					.then(() => session.messages.push("PDF_STEP" + seq + " timeout")),
			]);
		}
	}
	catch (e) {
		session.messages.push("PDF_STEP" + seq + " EXC " + (e && e.message ? e.message : e));
	}
	let out = session.messages.slice(start);
	zscLog("pdf step " + seq + ": " + (out.join(" | ") || "(no messages)"));
	return out;
}

/** 面板是否已经停在 ChatGPT 页面上；没就绪就等一会儿（最多约 5 秒） */
async function zscPdfWaitReady(tries) {
	tries = typeof tries === "number" ? tries : 7;
	for (let i = 0; i < tries; i++) {
		if (ZSC.panel && ZSC.panel.browser && zscPanelOnChat({ ignoreLoading: true })) {
			return true;
		}
		await Zotero.Promise.delay(700);
	}
	return false;
}

/**
 * 入口：把"当前这篇论文"的 PDF 送进面板里当前打开的那个对话。
 *
 * 不可违背的前提（用户明确要求）：**论文页必须原地不动**。
 * 所以这条链路里禁止出现任何导航行为——不切 Zotero 标签页、不选库里的条目、
 * 不动阅读器的左右侧栏、不重新打开阅读器。用户发完 PDF 就接着在原文上划句提问。
 * 回归由 `_recon/check_pdf_nav_safety.py` 守住（静态断言这些调用不出现）。
 */
async function zscSendPdf(options) {
	options = options || {};
	// 防重入：上一次发送还在跑（读文件 + 注入要几秒），再点只会开出并行的第二条
	// 管线，两条管线共用页面上同一个状态槽互相覆盖 —— 这是"多点几下才偶尔成功"的
	// 元凶之一。在飞时就直接忽略多余的点击。
	if (ZSC.pdfBusy) {
		zscLog("pdf: send already in progress, ignoring this click");
		zscSetStatus(zscT("pdfBusy"));
		return "busy";
	}
	ZSC.pdfBusy = true;
	try {
		return await zscSendPdfInner(options);
	}
	finally {
		ZSC.pdfBusy = false;
	}
}

async function zscSendPdfInner(options) {
	options = options || {};
	let zh = zscIsZh();
	let win = zscEnsureVisible(options);
	// silent：只把结果写进面板底部提示行，不弹 ProgressWindow
	// （那个系统小窗会"一闪而过"盖住屏幕，用户明确抱怨过）
	let silent = !!options.silent || !zscGetPref("toastOnSend", true);
	let toastIt = (msg) => {
		zscSetStatus(msg);
		if (!silent) {
			zscToast(win, msg);
		}
	};

	let info = await zscResolvePdf(options);
	if (!info) {
		toastIt(zscT("pdfNoPaper"));
		return "no-paper";
	}

	// 面板还没就绪（可能刚打开/还在加载）→ 等一等
	if (!(ZSC.panel && ZSC.panel.browser && zscPanelOnChat({ ignoreLoading: true }))) {
		zscSetStatus(zscT("pdfWaitingPanel"));
		if (!(await zscPdfWaitReady())) {
			ZSC.pendingPdf = options;
			zscPumpPendingPdf(2500);
			toastIt(zscT("pdfNotReady"));
			return "queued";
		}
	}

	zscSetStatus(zscT("pdfReading") + " " + info.name);
	let bytes = await zscReadFileBytes(info.path);
	if (!bytes || !bytes.length) {
		toastIt(zscT("pdfFailed") + (zh ? "：读不出文件内容" : ": could not read the file"));
		zscShowDiag("[pdf] read failed: " + info.path);
		return "failed";
	}
	if (bytes.length > ZSC_PDF_MAX_BYTES) {
		toastIt(zscT("pdfFailed") + (zh
			? "：文件太大（" + Math.round(bytes.length / 1048576) + "MB，上限 60MB）"
			: ": file too large (" + Math.round(bytes.length / 1048576) + "MB, limit 60MB)"));
		return "failed";
	}

	return await zscPdfUpload(bytes, info, win, { silent });
}

/** 真正干活的：初始化 → 探测直读 → （必要时）分片 → 装配附加 */
async function zscPdfUpload(bytes, info, win, options) {
	options = options || {};
	let zh = zscIsZh();
	let browser = ZSC.panel && ZSC.panel.browser;
	let silent = !!options.silent;
	let toastIt = (msg) => {
		zscSetStatus(msg);
		if (!silent && zscGetPref("toastOnSend", true)) {
			zscToast(win || Zotero.getMainWindow(), msg);
		}
	};

	let fileURI = zscPathToFileURI(info.path);
	let session = await zscNewInjectSession(browser);
	if (!session) {
		toastIt(zscT("pdfFailed") + (zh ? "：注入通道没建起来" : ": could not open the inject channel"));
		return "failed";
	}

	let messages = [];
	let ok = false;
	let verified = false;
	try {
		let meta = { name: info.name, size: bytes.length, url: fileURI };
		messages = await zscSessionInject(session, zscPdfInitCode(meta, ZSC_INJECT_ID + "-pdf-init"), 20000);

		messages = await zscSessionInject(session, zscPdfProbeCode(ZSC_INJECT_ID + "-pdf-probe"), 25000);
		let direct = messages.some(m => m.indexOf("PROBE_OK") === 0);

		if (!direct) {
			let total = Math.ceil(bytes.length / ZSC_PDF_CHUNK_BYTES);
			zscLog("pdf: direct read unavailable, pushing " + total + " chunk(s)");
			for (let i = 0; i < total; i++) {
				zscSetStatus(zscT("pdfUploading") + " " + (i + 1) + "/" + total);
				let start = i * ZSC_PDF_CHUNK_BYTES;
				let end = Math.min(start + ZSC_PDF_CHUNK_BYTES, bytes.length);
				let b64 = zscB64Encode(bytes, start, end);
				let stepMsgs = await zscSessionInject(
					session,
					zscPdfChunkCode(i, total, b64, ZSC_INJECT_ID + "-pdf-chunk-" + i),
					30000
				);
				if (stepMsgs.some(m => m.indexOf("CHUNK_NO_STATE") === 0)) {
					messages = stepMsgs;
					break;
				}
				messages = stepMsgs;
			}
		}
		else {
			zscLog("pdf: direct file:// read worked");
		}

		zscSetStatus(zscT("pdfUploading"));
		messages = await zscSessionInject(
			session,
			zscPdfAttachCode(ZSC_INJECT_ID + "-pdf-attach"),
			35000
		);
		ok = messages.some(m => m.indexOf("ATTACHED_VERIFIED") === 0 || m.indexOf("ATTACHED_UNCHECKED") === 0);
		verified = messages.some(m => m.indexOf("ATTACHED_VERIFIED") === 0);

		if (!ok) {
			zscCopyToClipboard(info.path);
			zscShowDiag("[pdf] " + (messages.join(" | ") || "no messages"));
		}
	}
	catch (e) {
		zscError(e);
		messages.push("EXC " + (e && e.message ? e.message : e));
	}
	finally {
		try {
			session.remote.dispose();
		}
		catch (e) { /* ignore */ }
	}

	if (ok) {
		toastIt(verified ? zscT("pdfDone") : zscT("pdfDoneUnverified"));
		return "sent";
	}
	zscShowDiag("[pdf] " + (messages.join(" | ") || "no messages"));
	toastIt(zscT("pdfFailed")
		+ (zh ? "：没能把文件放进输入框（路径已复制，可手动拖进去）"
			: ": could not place the file into the composer (path copied)"));
	return "failed";
}

/** 取去掉 "Zotero/x.y" 后缀的浏览器 UA */
function zscPlainUA() {
	try {
		let ua = Cc["@mozilla.org/network/protocol;1?name=http"]
			.getService(Ci.nsIHttpProtocolHandler).userAgent || "";
		ua = ua.replace(/\s*Zotero\/[\d.]+/i, "").trim();
		if (ua) {
			return ua;
		}
	}
	catch (e) { /* ignore */ }
	return ZSC_FALLBACK_UA;
}

/**
 * 让内嵌浏览器用一个"正常浏览器"的 UA 访问。
 * 用 browsingContext.customUserAgent（而非只改请求头），这样 navigator.userAgent
 * 与请求头一致，不会因为指纹矛盾被 Cloudflare 判定为异常客户端。
 */
function zscApplyBrowserUA(browser) {
	if (!browser) {
		return;
	}
	if (!zscGetPref("plainUserAgent", true)) {
		zscLog("UA override disabled by pref");
		return;
	}
	let ua = String(zscGetPref("customUserAgent", "") || "").trim() || zscPlainUA();
	let how = [];
	try {
		if (browser.browsingContext) {
			browser.browsingContext.customUserAgent = ua;
			how.push("bc");
		}
	}
	catch (e) {
		how.push("bc:X(" + e.name + ")");
	}
	try {
		if (browser.docShell) {
			browser.docShell.customUserAgent = ua;
			how.push("docShell");
		}
	}
	catch (e) {
		how.push("docShell:X");
	}
	zscLog("UA=" + ua + " [" + how.join(",") + "]");
}

/** 浏览器状态快照（写进黑匣子日志 + 面板底部诊断行） */
function zscLogBrowserState(tag) {
	let panel = ZSC && ZSC.panel;
	if (!panel || !panel.browser) {
		return;
	}
	let browser = panel.browser;
	let info = [];
	let uri = "";
	try {
		uri = browser.currentURI ? browser.currentURI.spec : "";
		info.push("uri=" + uri);
	}
	catch (e) {
		info.push("uri=ERR");
	}
	try {
		info.push("title=" + JSON.stringify(String(browser.contentTitle || "")));
	}
	catch (e) {
		info.push("title=ERR");
	}
	try {
		info.push("loading=" + (browser.webProgress ? browser.webProgress.isLoadingDocument : "?"));
	}
	catch (e) {
		info.push("loading=?");
	}
	try {
		let d = browser.contentDocument;
		if (d) {
			info.push("ready=" + d.readyState);
			let text = (d.body ? d.body.innerText : "") || "";
			info.push("text=" + JSON.stringify(text.replace(/\s+/g, " ").slice(0, 200)));
		}
		else {
			info.push("contentDocument=null(remote)");
		}
	}
	catch (e) {
		info.push("contentDocument=blocked(" + e.name + ")");
	}
	try {
		let hb = panel.host.getBoundingClientRect();
		let bb = browser.getBoundingClientRect();
		info.push("host=" + Math.round(hb.width) + "x" + Math.round(hb.height));
		info.push("browser=" + Math.round(bb.width) + "x" + Math.round(bb.height));
	}
	catch (e) { /* ignore */ }
	zscLog("[" + tag + "] " + info.join(" | "));

	if (panel.diag && zscGetPref("showDiag", false)) {
		try {
			let h = Math.round(panel.host.getBoundingClientRect().height);
			panel.diag.textContent = "[" + tag + "] " + uri + "  h=" + h
				+ "  " + String(browser.contentTitle || "");
		}
		catch (e) { /* ignore */ }
	}
}

/** 网络日志（限流，避免刷爆日志） */
function zscLogHttp(message) {
	if (!ZSC) {
		return;
	}
	ZSC.httpLogs = (ZSC.httpLogs || 0) + 1;
	if (ZSC.httpLogs > 400) {
		return;
	}
	zscLog(message);
}

/** 加载健康检查：超时仍是空白页就把提示语换成"加载失败" */
function zscCheckLoadHealth() {
	let panel = ZSC && ZSC.panel;
	if (!panel || !panel.browser) {
		return;
	}
	let uri = "";
	try {
		uri = panel.browser.currentURI ? panel.browser.currentURI.spec : "";
	}
	catch (e) { /* ignore */ }
	if (!uri || uri === "about:blank") {
		zscLog("health: browser still blank");
		if (panel.hint) {
			panel.hint.textContent = zscT("loadFail");
		}
	}
}

/* ------------------------------------------------------------------ */
/* 保底方案：在 Zotero 标签页里打开 ChatGPT                             */
/* ------------------------------------------------------------------ */

function zscFindChatTab() {
	try {
		let win = Zotero.getMainWindow();
		if (!win || !win.Zotero_Tabs) {
			return null;
		}
		for (let tab of win.Zotero_Tabs._tabs || []) {
			if (tab && tab.type === ZSC_TAB_TYPE) {
				return tab;
			}
		}
	}
	catch (e) { /* ignore */ }
	return null;
}

function zscOpenTab(url) {
	let win = Zotero.getMainWindow();
	if (!win || !win.Zotero_Tabs) {
		zscLog("openTab: Zotero_Tabs unavailable");
		return null;
	}
	url = url || (ZSC.panel && ZSC.panel.lastURL) || zscChatURL("");

	// 已存在就复用
	let existing = zscFindChatTab();
	if (existing) {
		try {
			win.Zotero_Tabs.select(existing.id);
			let box = win.document.getElementById(existing.id);
			let br = box && box.querySelector("browser");
			if (br) {
				zscNavigate(br, url);
				zscLog("openTab: reused tab " + existing.id);
				return existing.id;
			}
		}
		catch (e) {
			zscError(e);
		}
	}

	try {
		let { id, container } = win.Zotero_Tabs.add({
			type: ZSC_TAB_TYPE,
			title: zscProv().label,
			select: true,
		});
		try {
			container.setAttribute("style", "display:flex;flex-direction:column;");
		}
		catch (e) { /* ignore */ }
		let browser = zscCreateBrowser(win.document);
		container.appendChild(browser);
		zscApplyBrowserUA(browser);
		if (!ZSC.tabBrowsers) {
			ZSC.tabBrowsers = [];
		}
		ZSC.tabBrowsers = ZSC.tabBrowsers.filter(br => br && br.isConnected !== false);
		ZSC.tabBrowsers.push(browser);
		zscApplyZoom(browser);
		browser.addEventListener("load", () => {
			zscLog("tab browser load: " + String(browser.currentURI?.spec || ""));
		});
		browser.addEventListener("error", () => {
			zscLog("tab browser error: " + String(browser.currentURI?.spec || ""));
		});
		zscNavigate(browser, url);
		zscLog("openTab: created " + id);
		return id;
	}
	catch (e) {
		zscError(e);
		zscToast(win, "打开标签页失败: " + e);
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 右侧栏 section                                                      */
/* ------------------------------------------------------------------ */

function registerSection() {
	try {
		ZSC.sectionID = Zotero.ItemPaneManager.registerSection({
			paneID: "zoterogpt",
			pluginID: ZSC_ID,
			header: {
				l10nID: "zoterogpt-section-header",
				// 注册时就用当前服务的图标：Zotero 重启后 sidenav / 标题图标
				// 是按这里的值建的，写成静态图标会显得"没跟着 AI 切换"。
				icon: zscProvIconURL(zscProv().id, false),
				darkIcon: zscProvIconURL(zscProv().id, true),
			},
			sidenav: {
				l10nID: "zoterogpt-section-sidenav",
				// 侧边栏图标条这一格固定用中性图标：一排 Zotero 原生彩色小图标里
				// 插一家服务的 logo 会显得突兀，切到哪家都一样。
				icon: zscIconURL("ai-20.svg"),
				darkIcon: zscIconURL("ai-20.svg"),
			},
			// section 标题栏右侧的 📎 按钮：不占面板高度，但"看得见、点得到"。
			// 面板里的整行工具栏在 1.2.0 被要求移除过，所以入口只放这一个图标按钮。
			sectionButtons: [
				{
					// AI 选择：图标随当前服务变化（ChatGPT 结形 / DeepSeek 小鲸鱼），
					// 点一下弹出带图标的服务下拉菜单。
					type: "zsc-provider",
					icon: zscProvIconURL(zscProv().id, false),
					darkIcon: zscProvIconURL(zscProv().id, true),
					l10nID: "zoterogpt-section-btn-provider",
					onClick: (props) => {
						try {
							zscOpenProviderMenu(props);
						}
						catch (e) {
							zscError(e);
						}
					},
				},
				{
					type: "zsc-zoom-out",
					icon: zscIconURL("zoom-out-16.svg"),
					darkIcon: zscIconURL("zoom-out-16-dark.svg"),
					l10nID: "zoterogpt-section-btn-zoomout",
					onClick: () => {
						try {
							zscZoomStep(-ZSC_ZOOM_STEP);
						}
						catch (e) {
							zscError(e);
						}
					},
				},
				{
					type: "zsc-zoom-in",
					icon: zscIconURL("zoom-in-16.svg"),
					darkIcon: zscIconURL("zoom-in-16-dark.svg"),
					l10nID: "zoterogpt-section-btn-zoomin",
					onClick: () => {
						try {
							zscZoomStep(ZSC_ZOOM_STEP);
						}
						catch (e) {
							zscError(e);
						}
					},
				},
				{
					type: "zsc-send-pdf",
					icon: zscIconURL("send-16.svg"),
					darkIcon: zscIconURL("send-16-dark.svg"),
					l10nID: "zoterogpt-section-btn",
					onClick: () => {
						try {
							zscLog("section button: send current PDF");
							zscSendPdf({});
						}
						catch (e) {
							zscError(e);
						}
					},
				},
			],
			onInit: (props) => {
				try {
					zscLog("section init (paneID=" + (props && props.paneID) + ")");
					// init 时 body 已存在，直接把面板挂上，不等 render 调度
					zscOnRender(props);
					// 每次重建（含重启 / 切标签页）都把 sidenav、标题图标刷成当前服务，
					// 否则重启后侧边栏图标会停在注册时的静态值。
					zscRefreshProviderUI();
				}
				catch (e) {
					zscError(e);
				}
			},
			onRender: (props) => {
				try {
					zscOnRender(props);
				}
				catch (e) {
					zscError(e);
				}
			},
			onToggle: (props) => {
				try {
					let sectionEl = props && props.event && props.event.target;
					let opened = !!(sectionEl && sectionEl.open);
					zscLog("section toggled open=" + opened);
					// 防御：toggle 时若 body 还没挂上内容（例如首次 render 被跳过），补一次
					if (props && props.body && !props.body.firstElementChild) {
						zscLog("toggle: body empty, mounting now");
						zscOnRender(props);
					}
					zscEnsureBrowserLoaded();
					// 刚展开时才能量到有效高度，重新铺一次
					if (ZSC.panel && ZSC.panel.root) {
						zscApplyFillHeight(ZSC.panel.root, props && props.doc);
					}
				}
				catch (e) {
					zscError(e);
				}
			},
		});
		zscLog("section registered: " + ZSC.sectionID);
	}
	catch (e) {
		zscError(e);
	}
}

function zscOnRender({ doc, body }) {
	if (!doc || !body) {
		zscLog("onRender skipped: missing doc/body");
		return;
	}
	// Fluent 用纯文本消息翻译 section 标题时会清空 collapsible-section 的
	// 所有子元素（包括 body），此时 Zotero 传进来的 body 是已脱离文档的死节点。
	// 防御：找到当前文档里活着的 body（没有就给 section 补建一个），否则面板
	// 会挂到一个永远不可见的游离节点上。
	if (!body.isConnected) {
		zscLog("onRender: body detached, recovering live body");
		let liveBody = null;
		let sectionEl = null;
		for (let el of doc.querySelectorAll("item-pane-custom-section")) {
			if (String(el.dataset.pane || "").endsWith("zoterogpt")) {
				sectionEl = el;
				liveBody = el.querySelector('[data-type="body"]');
				break;
			}
		}
		if (!liveBody && sectionEl) {
			let collapsible = sectionEl.querySelector("collapsible-section");
			if (collapsible) {
				liveBody = doc.createElementNS(XHTML_NS, "div");
				liveBody.setAttribute("data-type", "body");
				collapsible.appendChild(liveBody);
				zscLog("onRender: recreated missing body element");
			}
		}
		if (liveBody) {
			body = liveBody;
			// 旧面板（若存在）挂在死节点上，作废重建
			if (ZSC.panel && ZSC.panel.root && !ZSC.panel.root.isConnected) {
				ZSC.panel = null;
			}
		}
	}
	zscLog("onRender: mounting panel (mounts=" + (ZSC.mounts || 0) + ")");
	injectWindowStyle(doc.defaultView || Zotero.getMainWindow(), doc);

	let mounted = ZSC.panel && ZSC.panel.root
		&& ZSC.panel.root.parentNode === body
		&& body.isConnected && ZSC.panel.root.isConnected;
	if (mounted) {
		// 已挂载：保持浏览器状态，不重建
		ZSC.panel.body = body;
		return;
	}

	let frag = doc.defaultView.MozXULElement.parseXULToFragment(ZSC_PANEL_MARKUP);
	let root = frag.firstElementChild;
	ZSC.mounts++;

	body.replaceChildren(root);

	let keepURL = ZSC.panel && ZSC.panel.lastURL ? ZSC.panel.lastURL : null;
	let host = root.querySelector("#zsc-browser-host");
	let browser = zscCreateBrowser(doc);

	ZSC.panel = {
		root,
		body,
		host,
		browser,
		diag: root.querySelector("#zsc-diag"),
		hint: root.querySelector("#zsc-hint"),
		resizer: root.querySelector("#zsc-resizer"),
		lastURL: keepURL,
		loaded: false,
	};

	if (host && browser) {
		host.appendChild(browser);
	}
	zscApplyBrowserUA(browser);
	zscApplyZoom();

	// 高度：默认铺满侧边栏（实测可用空间）；关掉填充才用固定高度，可拖拽调整
	if (zscGetPref("fillSidebar", true)) {
		zscApplyFillHeight(root, doc);
	}
	else {
		let height = parseInt(zscGetPref("panelHeight", 480), 10) || 480;
		root.style.height = height + "px";
	}

	bindPanelEvents(root, browser);

	if (ZSC.mounts > 1) {
		zscLog("panel re-mounted (#" + ZSC.mounts + "), restoring " + (keepURL || "home"));
		zscNavigate(browser, keepURL || zscChatURL(""));
		ZSC.panel.loaded = true;
	}

	// 先保证 section 展开——折叠状态下 body 不可见，用户会以为"什么都没渲染"。
	// 必须在加载网页之前做：不可见的 browser 有时不会开始加载。
		try {
			let section = root.closest("collapsible-section");
			zscDecorateSectionButtons(section);
			if (section && !section.open && zscGetPref("autoOpen", true)) {
				zscLog("auto-opening section");
				zscSetSectionOpen(section, true);
			}
		}
	catch (e) {
		zscError(e);
	}

	// 待发送的划词内容：先按"上次停留的对话"把页面加载出来（没有才用首页），
	// 然后等页面就绪、注入面板**当前显示的对话**。
	// 绝不能走 zscSendPrompt —— 那会导航到 ?q= 开一个新对话，把用户正看的对话顶掉。
	if (ZSC.pendingPrompt) {
		let prompt = ZSC.pendingPrompt;
		ZSC.pendingPrompt = null;
		zscEnsureBrowserLoaded();
		zscDeliverPrompt(prompt).catch((e) => zscError(e));
	}
	// 待发送的"新对话"提问（只有显式要求新对话时才会排到这里）
	else if (ZSC.pendingNewChat) {
		let prompt = ZSC.pendingNewChat;
		ZSC.pendingNewChat = null;
		zscSendPrompt(prompt);
	}
	else {
		zscEnsureBrowserLoaded();
	}

	if (ZSC.pendingStatus) {
		zscSetStatus(ZSC.pendingStatus);
		ZSC.pendingStatus = null;
	}

	// 待发送的 PDF：用户点了按钮但面板还没挂载，这里补发。
	// 只等页面就绪再注入，**不做任何导航**——用户看论文的阅读器标签页必须原地不动。
	if (ZSC.pendingPdf) {
		zscLog("pending PDF queued, pumping after panel mount");
		zscPumpPendingPdf(1500);
	}
}

/**
 * 补发队列的"泵"。
 *
 * 面板没挂载时 `zscOnRender` 根本不会触发，光靠它会把排队的 PDF 永远晾着，
 * 用户看到的就是"点了没反应"。所以这里既被 onRender 调用，也会自己按固定
 * 间隔重试，最多约 30 秒；期间绝不切任何页面。
 */
function zscPumpPendingPdf(delayMs) {
	if (!ZSC || !ZSC.pendingPdf) {
		return;
	}
	let wait = typeof delayMs === "number" ? delayMs : 1500;
	let pwin = null;
	try {
		pwin = Zotero.getMainWindow();
	}
	catch (e) { /* ignore */ }
	if (!pwin || !pwin.setTimeout) {
		return;
	}
	pwin.setTimeout(() => {
		try {
			if (!ZSC.pendingPdf) {
				return;
			}
			if (!(ZSC.panel && ZSC.panel.browser)) {
				ZSC.pdfPumpTries = (ZSC.pdfPumpTries || 0) + 1;
				if (ZSC.pdfPumpTries < 15) {
					zscPumpPendingPdf(2000);
					return;
				}
				zscLog("pdf: panel never mounted, giving up after " + ZSC.pdfPumpTries + " tries");
			}
			let opts = ZSC.pendingPdf;
			ZSC.pendingPdf = null;
			ZSC.pdfPumpTries = 0;
			zscSendPdf(opts).catch((e) => zscError(e));
		}
		catch (e) {
			zscError(e);
		}
	}, wait);
}

/**
 * 找到"我们那个" collapsible-section。
 *
 * 注册时的 paneID 会被 ItemPaneManager 命名空间化成
 * `CSS.escape("<pluginID>-<paneID>")`（实测 = `zoterogpt-sidebar@workbuddy.local-zoterogpt`），
 * 也就是 data-pane 的实际值，所以只能按后缀认。文库页面的条目面板和阅读器右侧栏
 * （context pane）各有一份，谁先挂上面板就返回谁。
 */
function zscFindSectionEl(doc) {
	try {
		let root = doc || (Zotero.getMainWindow() || {}).document;
		if (!root) {
			return null;
		}
		let fallback = null;
		for (let el of root.querySelectorAll("collapsible-section")) {
			let pane = String(el.dataset.pane || "");
			if (!pane.endsWith("zoterogpt")) {
				continue;
			}
			if (el.querySelector("#zsc-root")) {
				return el;
			}
			if (!fallback) {
				fallback = el;
			}
		}
		return fallback;
	}
	catch (e) {
		return null;
	}
}

/**
 * 以程序方式展开/折叠 section（带防御的统一入口）。
 * Zotero 的 collapsible-section 无论"谁来改 open"都会 dispatch 一个 toggle 事件，
 * onToggle 里只做挂载/量高这类中性工作、不携带发送副作用，所以无需抑制标记。
 */
function zscSetSectionOpen(section, open) {
	if (!section) {
		return false;
	}
	try {
		section.open = !!open;
	}
	catch (e) {
		zscError(e);
		return false;
	}
	return true;
}

/**
 * 把 section 标题栏上那个 📎 按钮说明白。
 *
 * 按钮由 collapsible-section._buildExtraButtons() 生成，l10n 走的是
 * `section-button-<type>` 这套内置格式；我们这里直接把 data-l10n-id 摘掉、
 * 自己写 tooltiptext，免得依赖 FTL 时序（谁后写谁生效）。
 */
/* ------------------------------------------------------------------ */
/* AI 服务下拉菜单（标题栏图标按钮 → 带图标的选择菜单）                 */
/* ------------------------------------------------------------------ */

const ZSC_PROV_MENU_CSS = `
.zsc-prov-menu {
	position: fixed;
	z-index: 2147483647;
	min-width: 196px;
	padding: 6px;
	border-radius: 10px;
	border: 1px solid rgba(0,0,0,.12);
	background: #ffffff;
	color: #16181d;
	box-shadow: 0 10px 28px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.10);
	font: 13px/1.35 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
	-webkit-user-select: none;
	user-select: none;
}
.zsc-prov-item {
	display: flex;
	align-items: center;
	gap: 9px;
	padding: 7px 9px;
	border-radius: 7px;
	cursor: pointer;
}
.zsc-prov-item:hover { background: rgba(77,107,254,.12); }
.zsc-prov-item[data-current="true"] { background: rgba(77,107,254,.10); }
.zsc-prov-item img { width: 18px; height: 18px; flex: 0 0 auto; }
.zsc-prov-name { flex: 1 1 auto; white-space: nowrap; }
.zsc-prov-item[data-current="true"] .zsc-prov-name { font-weight: 600; }
.zsc-prov-check { flex: 0 0 auto; width: 12px; color: #4D6BFE; font-weight: 700; opacity: 0; }
.zsc-prov-item[data-current="true"] .zsc-prov-check { opacity: 1; }
.zsc-prov-sep { height: 1px; margin: 5px 7px; background: rgba(0,0,0,.10); }
.zsc-prov-foot {
	padding: 4px 9px 2px;
	font-size: 11px;
	line-height: 1.35;
	color: #7a7f8a;
	white-space: nowrap;
}
@media (prefers-color-scheme: dark) {
	.zsc-prov-menu {
		border-color: rgba(255,255,255,.14);
		background: #2b2b2d;
		color: #f2f2f4;
		box-shadow: 0 10px 28px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.35);
	}
	.zsc-prov-item:hover { background: rgba(140,162,255,.20); }
	.zsc-prov-item[data-current="true"] { background: rgba(140,162,255,.16); }
	.zsc-prov-sep { background: rgba(255,255,255,.12); }
	.zsc-prov-foot { color: #9aa0ad; }
}
`;

function zscEnsureProvStyle(doc) {
	try {
		if (!doc || doc.getElementById("zsc-prov-style")) {
			return;
		}
		let style = doc.createElementNS(XHTML_NS, "style");
		style.id = "zsc-prov-style";
		style.textContent = ZSC_PROV_MENU_CSS;
		(doc.documentElement || doc.body).appendChild(style);
	}
	catch (e) { /* ignore */ }
}

/** 所有主窗口（多窗口时下拉菜单和图标都要同步） */
function zscAllWindows() {
	try {
		let list = Zotero.getMainWindows ? Zotero.getMainWindows() : null;
		if (list && list.length) {
			return Array.from(list);
		}
	}
	catch (e) { /* ignore */ }
	try {
		let win = Zotero.getMainWindow();
		return win ? [win] : [];
	}
	catch (e) {
		return [];
	}
}

function zscWindowIsDark(win) {
	try {
		return !!win.matchMedia("(prefers-color-scheme: dark)").matches;
	}
	catch (e) {
		return false;
	}
}

/** 把当前服务的图标写到「某一个」section 的按钮和标题图标上 */
function zscApplyProviderIcon(sectionEl) {
	try {
		if (!sectionEl) {
			return;
		}
		let prov = zscProv();
		let btn = sectionEl.querySelector(".section-custom-button.zsc-provider");
		if (btn) {
			btn.style.setProperty("--custom-button-icon-light", "url('" + zscProvIconURL(prov.id, false) + "')");
			btn.style.setProperty("--custom-button-icon-dark", "url('" + zscProvIconURL(prov.id, true) + "')");
			let tip = zscT("providerBtn").replace("%s", prov.label);
			btn.removeAttribute("data-l10n-id");
			btn.setAttribute("tooltiptext", tip);
			btn.setAttribute("aria-label", tip);
		}
		// section 标题图标也跟着当前服务走（Fluent 重渲染后会被重置，所以每次都刷）
		let sectionRoot = sectionEl.closest ? sectionEl.closest("item-pane-custom-section") : null;
		if (sectionRoot) {
			sectionRoot.style.setProperty(
				"--custom-section-icon-light",
				"url('" + zscProvIconURL(prov.id, false) + "')"
			);
			sectionRoot.style.setProperty(
				"--custom-section-icon-dark",
				"url('" + zscProvIconURL(prov.id, true) + "')"
			);
		}
	}
	catch (e) { /* ignore */ }
}

/** 切换服务后刷新所有窗口里的图标、标题图标、侧栏图标签和设置面板下拉 */
function zscRefreshProviderUI() {
	let prov = zscProv();
	for (let win of zscAllWindows()) {
		let doc = win && win.document;
		if (!doc) {
			continue;
		}
		try {
			// 1) 面板标题栏按钮
			for (let sectionEl of doc.querySelectorAll("item-pane-custom-section")) {
				if (!String(sectionEl.dataset.pane || "").endsWith("zoterogpt")) {
					continue;
				}
				zscApplyProviderIcon(sectionEl.querySelector("collapsible-section") || sectionEl);
				// 2) section 标题图标（CSS 变量直接挂在自定义元素上）
				sectionEl.style.setProperty(
					"--custom-section-icon-light",
					"url('" + zscProvIconURL(prov.id, false) + "')"
				);
				sectionEl.style.setProperty(
					"--custom-section-icon-dark",
					"url('" + zscProvIconURL(prov.id, true) + "')"
				);
				// 3) 记住 sidenav 选项（固定中性图标，不随服务变），Zotero 重建按钮时用它
				try {
					let opts = JSON.parse(sectionEl.dataset.sidenavOptions || "{}");
					opts.icon = zscIconURL("ai-20.svg");
					opts.darkIcon = zscIconURL("ai-20.svg");
					sectionEl.dataset.sidenavOptions = JSON.stringify(opts);
				}
				catch (e) { /* ignore */ }
			}
			// 4) 右侧图标条上的那一格：固定中性图标，切 AI 不换
			for (let btn of doc.querySelectorAll('.btn[data-pane="zoterogpt"]')) {
				btn.style.setProperty(
					"--custom-sidenav-icon-light",
					"url('" + zscIconURL("ai-20.svg") + "')"
				);
				btn.style.setProperty(
					"--custom-sidenav-icon-dark",
					"url('" + zscIconURL("ai-20.svg") + "')"
				);
			}
			// 5) 设置面板里的下拉框
			let sel = doc.getElementById("zsc-pref-provider");
			if (sel && String(sel.value || "") !== prov.id) {
				sel.value = prov.id;
			}
		}
		catch (e) { /* 单个窗口失败不影响其他窗口 */ }
	}
}

function zscCloseProviderMenu() {
	let st = ZSC && ZSC.provMenu;
	if (!st) {
		return;
	}
	ZSC.provMenu = null;
	try { st.cleanup(); }
	catch (e) { /* ignore */ }
	try { st.el.remove(); }
	catch (e) { /* ignore */ }
	try { st.doc.getElementById("zsc-prov-anchor-active")?.removeAttribute("id"); }
	catch (e) { /* ignore */ }
}

/** 点标题栏的服务图标：弹出带 logo 的服务选择菜单 */
function zscOpenProviderMenu(props) {
	let ev = props && props.event;
	let btn = (ev && ev.detail && ev.detail.button) || null;
	if (!btn && ev && ev.target && ev.target.querySelector) {
		btn = ev.target.querySelector(".section-custom-button.zsc-provider");
	}
	let doc = (props && props.doc) || (btn && btn.ownerDocument) || null;
	if (!doc) {
		try { doc = Zotero.getMainWindow().document; }
		catch (e) { return; }
	}
	// 同一个按钮再点一次 = 收起
	if (ZSC.provMenu) {
		let same = ZSC.provMenu.anchor === btn;
		zscCloseProviderMenu();
		if (same) {
			return;
		}
	}
	zscEnsureProvStyle(doc);
	zscLog("provider menu: open (current=" + zscProv().id + ")");

	let dark = zscWindowIsDark(doc.defaultView);
	let current = zscProv().id;
	let menu = doc.createElementNS(XHTML_NS, "div");
	menu.className = "zsc-prov-menu";
	menu.setAttribute("role", "menu");

	for (let id of zscProviderIDs()) {
		let prov = ZSC_PROVIDERS[id];
		let item = doc.createElementNS(XHTML_NS, "div");
		item.className = "zsc-prov-item";
		item.dataset.prov = id;
		item.setAttribute("role", "menuitem");
		item.setAttribute("tabindex", "0");
		if (id === current) {
			item.dataset.current = "true";
		}
		let img = doc.createElementNS(XHTML_NS, "img");
		img.setAttribute("src", zscProvIconURL(id, dark));
		img.setAttribute("alt", "");
		let name = doc.createElementNS(XHTML_NS, "span");
		name.className = "zsc-prov-name";
		name.textContent = prov.label;
		let check = doc.createElementNS(XHTML_NS, "span");
		check.className = "zsc-prov-check";
		check.textContent = "✓";
		item.appendChild(img);
		item.appendChild(name);
		item.appendChild(check);
		item.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			zscSetProvider(id);
		});
		item.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				zscSetProvider(id);
			}
		});
		menu.appendChild(item);
	}

	let sep = doc.createElementNS(XHTML_NS, "div");
	sep.className = "zsc-prov-sep";
	menu.appendChild(sep);
	let foot = doc.createElementNS(XHTML_NS, "div");
	foot.className = "zsc-prov-foot";
	foot.textContent = zscIsZh() ? "切换后自动载入对应站点" : "Loads that site on switch";
	menu.appendChild(foot);

	(doc.documentElement || doc.body).appendChild(menu);

	// 定位在按钮左下方；下方空间不够就翻到上方
	let rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
	let box = menu.getBoundingClientRect();
	let vw = doc.defaultView.innerWidth || 1000;
	let vh = doc.defaultView.innerHeight || 800;
	let left = rect ? rect.left : (vw - box.width - 24);
	let top = rect ? rect.bottom + 6 : 80;
	if (left + box.width > vw - 8) {
		left = Math.max(8, vw - box.width - 8);
	}
	if (top + box.height > vh - 8) {
		top = rect ? Math.max(8, rect.top - box.height - 6) : Math.max(8, vh - box.height - 8);
	}
	menu.style.left = Math.round(left) + "px";
	menu.style.top = Math.round(top) + "px";

	// 关闭条件：点空白处 / Esc / 滚动 / 窗口尺寸变化 / 切换标签
	let win = doc.defaultView;
	let onDown = (e) => {
		if (!menu.contains(e.target)) {
			zscCloseProviderMenu();
		}
	};
	let onKey = (e) => {
		if (e.key === "Escape") {
			zscCloseProviderMenu();
		}
	};
	let onClose = () => zscCloseProviderMenu();
	// 刚展开 section 时 Zotero 可能会滚动一下，菜单别被自己关掉
	let armed = false;
	let armTimer = win.setTimeout(() => { armed = true; }, 300);
	let onScroll = () => {
		if (armed) {
			zscCloseProviderMenu();
		}
	};
	let cleanup = () => {
		try { win.clearTimeout(armTimer); } catch (e) { /* ignore */ }
		try { win.removeEventListener("mousedown", onDown, true); } catch (e) { /* ignore */ }
		try { win.removeEventListener("keydown", onKey, true); } catch (e) { /* ignore */ }
		try { win.removeEventListener("resize", onClose, true); } catch (e) { /* ignore */ }
		try { win.removeEventListener("scroll", onScroll, true); } catch (e) { /* ignore */ }
		try { win.removeEventListener("deactivate", onClose, true); } catch (e) { /* ignore */ }
	};
	win.addEventListener("mousedown", onDown, true);
	win.addEventListener("keydown", onKey, true);
	win.addEventListener("resize", onClose, true);
	win.addEventListener("scroll", onScroll, true);
	// 窗口切走时收起。注意不能用 blur：blur 会从按钮等子元素冒到窗口（捕获阶段），
	// 菜单刚打开就自己关掉了。
	win.addEventListener("deactivate", onClose, true);

	ZSC.provMenu = { el: menu, doc, anchor: btn, cleanup };
}

/** 切换 AI 服务：写偏好 → 刷新图标 → 面板载入对应站点 */
function zscSetProvider(id) {
	if (!Object.prototype.hasOwnProperty.call(ZSC_PROVIDERS, id)) {
		return;
	}
	// 用 lastProvider 而不是读偏好判断"是否切换"：设置面板的通用绑定可能已经先写了偏好，
	// 读偏好会得到新值，导致误判成"没变"而跳过导航。
	let prev = ZSC.lastProvider || null;
	zscCloseProviderMenu();
	zscSetPref("provider", id);
	ZSC.lastProvider = id;
	if (prev === id) {
		zscRefreshProviderUI();
		return;
	}
	zscLog("provider switched: " + prev + " -> " + id);
	zscRefreshProviderUI();
	zscSwitchProvider();
}

function zscDecorateSectionButtons(sectionEl) {
	try {
		if (!sectionEl) {
			return;
		}
		let map = {
			"zsc-send-pdf": zscT("sendPdfBtn"),
			"zsc-zoom-out": zscT("zoomOut") + " (−10%)",
			"zsc-zoom-in": zscT("zoomIn") + " (+10%)",
		};
		for (let type of Object.keys(map)) {
			let btn = sectionEl.querySelector(".section-custom-button." + type);
			if (!btn) {
				continue;
			}
			btn.removeAttribute("data-l10n-id");
			btn.setAttribute("tooltiptext", map[type]);
			btn.setAttribute("aria-label", map[type]);
		}
		// AI 服务按钮的图标/tooltip 要跟着当前服务走（按钮会被 Zotero 重建，每次渲染都刷一次）
		zscApplyProviderIcon(sectionEl);
	}
	catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 右侧栏图标条：点一下 = 展开插件面板（发送只走 📎 按钮）              */
/* ------------------------------------------------------------------ */

/**
 * 右侧栏图标条上"我们这一格"的点击 = 用户口中"点开插件"。
 *
 * 图标条在文库页面的条目面板和阅读器的右侧栏各有一份，所以用文档级委托
 * （捕获阶段）监听，一次覆盖两处。点击本身 Zotero 只会 scrollToPane，
 * 不会展开折叠的 section —— 这里顺手帮它展开。
 */
function zscOnPaneButtonClick(event) {
	try {
		if (!event || event.button !== 0) {
			return;
		}
		let target = event.target;
		if (!target || !target.closest) {
			return;
		}
		let btn = target.closest(".btn[data-pane]");
		if (!btn) {
			return;
		}
		let pane = String(btn.dataset.pane || "");
		if (!pane.endsWith("zoterogpt")) {
			return;
		}
		zscLog("pane icon clicked: " + pane);
		let section = zscFindSectionEl(btn.ownerDocument || null);
		if (section && !section.open) {
			zscSetSectionOpen(section, true);
		}
	}
	catch (e) {
		zscError(e);
	}
}

function zscIsSectionOpen(root) {
	try {
		let section = root.closest("collapsible-section");
		return !!(section && section.open);
	}
	catch (e) {
		return false;
	}
}

/**
 * 让面板铺满侧边栏的剩余高度。
 *
 * 面板上方还压着标签栏 / 条目面板头部 / section 头部，高度随场景变化（主窗口文库
 * 与阅读器右侧栏就不同），写死像素必然留白或溢出。这里实测：
 *   可用高度 = 窗口可视高度 − 面板顶部在窗口里的 y 坐标 − 底部留白
 * 并在窗口尺寸变化时重算。想固定高度时把 pref fillSidebar 关掉即可。
 */
function zscApplyFillHeight(root, doc) {
	if (!root) {
		return;
	}
	if (!zscGetPref("fillSidebar", true)) {
		root.classList.remove("zsc-fill");
		return;
	}
	root.classList.add("zsc-fill");
	let measure = () => {
		try {
			let win = (doc || root.ownerDocument).defaultView;
			if (!win || !root.isConnected) {
				return;
			}
			// 折叠时量不到有效值，等展开后由 toggle 再触发
			if (!zscIsSectionOpen(root)) {
				return;
			}
			// 面板下方还有别的 section（如「信息」）：给它们留出实际高度，
			// 否则面板把整个侧边栏占满后，下面的 section 会被顶出可视区。
			let reserve = 6;
			try {
				let sec = root.closest("item-pane-custom-section, collapsible-section");
				let sib = sec && sec.nextElementSibling;
				while (sib) {
					let h = 0;
					try { h = sib.offsetHeight || 0; } catch (e) { /* ignore */ }
					if (h > 0) {
						reserve += h + 3; // 3px 近似 section 间距
					}
					sib = sib.nextElementSibling;
				}
			}
			catch (e) { /* ignore */ }
			let rect = root.getBoundingClientRect();
			let avail = Math.floor(win.innerHeight - rect.top - reserve);
			avail = Math.max(260, Math.min(2400, avail));
			if (Math.abs(avail - (ZSC.fillHeight || 0)) > 2) {
				ZSC.fillHeight = avail;
				root.style.height = avail + "px";
				zscLog("fill height=" + avail + " (reserve=" + reserve + ")");
			}
		}
		catch (e) { /* ignore */ }
	};
	measure();
	// 首帧布局常常还没稳，补量两次（bootstrap 作用域不保证有裸 setTimeout，用窗口的）
	let win0 = null;
	try {
		win0 = (doc || root.ownerDocument).defaultView;
	}
	catch (e) { /* ignore */ }
	let later = (fn, ms) => {
		try {
			if (win0 && win0.setTimeout) {
				win0.setTimeout(fn, ms);
				return;
			}
		}
		catch (e) { /* ignore */ }
		try {
			Zotero.Promise.delay(ms).then(fn);
		}
		catch (e) { /* ignore */ }
	};
	later(measure, 60);
	later(measure, 320);
	later(measure, 1200); // 阅读器右侧栏挂载初期布局抖得厉害，再多补一次
	try {
		let win = (doc || root.ownerDocument).defaultView;
		if (win && ZSC.fillWin !== win) {
			zscRemoveFillListener();
			ZSC.fillWin = win;
			ZSC.fillListener = () => measure();
			win.addEventListener("resize", ZSC.fillListener);
		}
	}
	catch (e) { /* ignore */ }
	// 侧边栏里其他 section（信息/注释等）折叠、展开或增删时，可用高度会变，
	// 用 MutationObserver 盯住 section 容器，防抖后重新量。
	try {
		if (win0 && !ZSC.fillObserver) {
			let secEl = root.closest("item-pane-custom-section, collapsible-section");
			let container = secEl && secEl.parentElement;
			if (container && win0.MutationObserver) {
				let pending = false;
				ZSC.fillObserver = new win0.MutationObserver(() => {
					if (pending) {
						return;
					}
					pending = true;
					later(() => {
						pending = false;
						measure();
					}, 180);
				});
				ZSC.fillObserver.observe(container, {
					childList: true,
					attributes: true,
					subtree: true,
					attributeFilter: ["open", "hidden", "collapsed", "style", "class"],
				});
			}
		}
	}
	catch (e) { /* ignore */ }
}

function zscRemoveFillListener() {
	try {
		if (ZSC && ZSC.fillWin && ZSC.fillListener) {
			ZSC.fillWin.removeEventListener("resize", ZSC.fillListener);
		}
	}
	catch (e) { /* ignore */ }
	try {
		if (ZSC && ZSC.fillObserver) {
			ZSC.fillObserver.disconnect();
		}
	}
	catch (e) { /* ignore */ }
	if (ZSC) {
		ZSC.fillWin = null;
		ZSC.fillListener = null;
		ZSC.fillObserver = null;
	}
}

function bindPanelEvents(root, browser) {
	// 高度拖拽：一旦手动拖过，就退出"铺满"模式，改由固定高度接管
	let resizer = root.querySelector("#zsc-resizer");
	if (resizer) {
		resizer.addEventListener("mousedown", (event) => {
			event.preventDefault();
			let win = root.ownerDocument.defaultView;
			zscSetPref("fillSidebar", false);
			root.classList.remove("zsc-fill");
			ZSC.resizing = {
				startY: event.screenY,
				startHeight: root.getBoundingClientRect().height,
				win,
			};
			win.addEventListener("mousemove", zscOnResizeMove, true);
			win.addEventListener("mouseup", zscOnResizeUp, true);
		});
	}

	if (!browser) {
		zscLog("bindPanelEvents: no browser element!");
		return;
	}

	// 内嵌页加载全过程诊断
	browser.addEventListener("loadstart", () => zscLogBrowserState("loadstart"));
	browser.addEventListener("DOMContentLoaded", () => zscLogBrowserState("DOMContentLoaded"));
	browser.addEventListener("pageshow", () => zscLogBrowserState("pageshow"));
	browser.addEventListener("error", () => zscLogBrowserState("error"));
	browser.addEventListener("load", () => {
		try {
			ZSC.panel.loaded = true;
			let spec = "";
			try {
				spec = browser.currentURI?.spec || "";
			}
			catch (e) { /* ignore */ }
			if (spec && spec !== "about:blank") {
				ZSC.panel.lastURL = spec;
				// 页面实际加载成功了：清掉健康检查提前写下的"加载失败"提示，
				// 否则它在悬浮层里一直盖着页面底部
				let ph = ZSC.panel && ZSC.panel.hint;
				if (ph && ph.textContent === zscT("loadFail")) {
					ph.textContent = "";
				}
			}
			zscApplyZoom();
			zscLogBrowserState("load");
		}
		catch (e) {
			zscError(e);
		}
	});

	// 定时快照：捕获"加载完了但页面是空的 / 卡在验证"这类情况
	try {
		let win = root.ownerDocument.defaultView;
		if (win && win.setTimeout) {
			for (let delay of [2500, 6000, 12000, 20000, 35000]) {
				win.setTimeout(() => {
					try {
						zscLogBrowserState("t+" + Math.round(delay / 1000) + "s");
						zscCheckLoadHealth();
					}
					catch (e) { /* ignore */ }
				}, delay);
			}
		}
	}
	catch (e) { /* ignore */ }
}

function zscOnResizeMove(event) {
	if (!ZSC?.resizing || !ZSC.panel) {
		return;
	}
	let delta = event.screenY - ZSC.resizing.startY;
	let height = Math.max(180, Math.min(1600, Math.round(ZSC.resizing.startHeight + delta)));
	ZSC.panel.root.style.height = height + "px";
	ZSC.resizing.height = height;
}

function zscOnResizeUp() {
	if (!ZSC?.resizing || !ZSC.panel) {
		return;
	}
	let win = ZSC.resizing.win;
	try {
		win.removeEventListener("mousemove", zscOnResizeMove, true);
		win.removeEventListener("mouseup", zscOnResizeUp, true);
	}
	catch (e) { /* ignore */ }
	if (ZSC.resizing.height) {
		zscSetPref("panelHeight", ZSC.resizing.height);
	}
	ZSC.resizing = null;
}

function zscEnsureBrowserLoaded() {
	let panel = ZSC?.panel;
	if (!panel || !panel.browser) {
		return false;
	}
	if (panel.loaded) {
		return true;
	}
	panel.loaded = true;
	let url = panel.lastURL || zscChatURL("");
	panel.lastURL = url;
	zscSetStatus(zscT("loading"));
	zscNavigate(panel.browser, url);
	return true;
}

function zscSetStatus(message) {
	// 工具栏已移除：瞬时反馈（加载中/已发送/已复制等）写到面板底部的 hint 行
	if (ZSC?.panel?.hint) {
		ZSC.panel.hint.textContent = message;
	}
	else if (ZSC) {
		ZSC.pendingStatus = message;
	}
}

function zscCookieStatus() {
	let status = { count: 0, session: false, error: null };
	try {
		let enumerator = null;
		try {
			enumerator = Services.cookies.getCookiesFromHost(zscProv().cookieHost, {});
		}
		catch (e) {
			try {
				enumerator = Services.cookies.getCookiesFromHost(zscProv().cookieHost);
			}
			catch (e2) {
				enumerator = null;
			}
		}
		if (enumerator) {
			while (enumerator.hasMoreElements()) {
				let cookie = enumerator.getNext();
				status.count++;
				let name = String(cookie.name || "");
				if (new RegExp(zscProv().sessionCookie, "i").test(name)) {
					status.session = true;
				}
			}
		}
	}
	catch (e) {
		status.error = String(e);
	}
	return status;
}

/* ------------------------------------------------------------------ */
/* 提问                                                                */
/* ------------------------------------------------------------------ */

function zscBuildPrompt(kind, vars) {
	let template = ZSC_ITEM_PROMPTS[kind] || "{text}";
	let out = String(template);
	for (let key of Object.keys(vars || {})) {
		let value = vars[key];
		out = out.split("{" + key + "}").join(value === undefined || value === null ? "" : String(value));
	}
	return out.trim();
}

/**
 * 发送入口。**优先送进面板里当前显示的那个对话**——不跳页、不新开对话、
 * 绝不顶掉用户正看着的对话。页面还没就绪时交给 zscDeliverPrompt 轮询等待，
 * 等不到就退回剪贴板。只有当用户在设置里主动关掉「优先发送到当前对话」时，
 * 才用 ?q= 开一个新对话。
 */
async function zscAsk(text, options) {
	let content = String(text === undefined || text === null ? "" : text).trim();
	if (!content) {
		return;
	}
	options = options || {};
	let win = zscEnsureVisible(options);

	if (String(zscGetPref("sendMode", "current") || "current") === "clipboard") {
		zscCopyToClipboard(content);
		zscSetStatus(zscT("copied"));
		if (zscGetPref("toastOnSend", true)) {
			zscToast(win, zscT("copied"));
		}
		return;
	}

	// 面板还没建起来：先记下。等 onRender 把面板建好、页面加载完，再注入**当前对话**。
	if (!ZSC.panel || !ZSC.panel.browser) {
		ZSC.pendingPrompt = content;
		let msg = zscIsZh()
			? "侧边栏已展开，正在准备对话…"
			: "Sidebar opening — preparing the conversation…";
		zscSetStatus(msg);
		if (zscGetPref("toastOnSend", true)) {
			zscToast(win, msg);
		}
		return;
	}

	// 只要面板停在 ChatGPT 上（哪怕还在加载中），就一律注入**它当前显示的那个对话**。
	// 绝不走 ?q= 新开对话——那会把用户正看着的对话顶掉（用户实报过这个 bug）。
	if (zscGetPref("preferCurrentChat", true)) {
		// 页面还没加载完、输入框还没渲染出来 → 交给 zscDeliverPrompt 轮询等它就绪
		if (!zscPanelPageReady()) {
			zscSetStatus(zscIsZh() ? "正在准备侧边栏…" : "Preparing sidebar…");
			zscDeliverPrompt(content).catch((e) => zscError(e));
			return;
		}
		zscSetStatus(zscIsZh() ? "正在发送…" : "Sending…");
		let res = await zscInjectIntoPage(content);
		if (res.ok) {
			// 内容已经在输入框里、只是没确认发出时，**绝不能**报"失败并已复制"——
			// 那会让用户以为没发出去而反复重试，同一条内容被发好几遍。
			let msg = res.confirmed ? zscT("sentCurrent") : zscT("sentUnclear");
			zscSetStatus(msg);
			if (zscGetPref("toastOnSend", true)) {
				zscToast(win, msg);
			}
			return;
		}
		// "页面/输入框还没就绪"这类失败值得再等几轮，不该立刻放弃
		if (zscInjectRetriable(res.messages)) {
			zscDeliverPrompt(content).catch((e) => zscError(e));
			return;
		}
		// 其他失败：别静默，也别把当前对话换成新对话——复制到剪贴板并说清原因
		let reason = zscExplainInjectFailure(res.messages);
		zscLog("inject failed: " + (res.messages.join(" | ") || "(no messages)"));
		zscCopyToClipboard(content);
		zscSetStatus(reason);
		zscShowDiag("[inject] " + (res.messages.join(" | ") || "no messages"));
		if (zscGetPref("toastOnSend", true)) {
			zscToast(win, reason);
		}
		return;
	}

	// 用户显式关掉了设置里的「优先发送到当前对话」→ 保留旧行为：用 ?q= 开一个新对话
	zscSendPrompt(content, win);
}

/** 把注入失败的原因翻译成一句人话 */
function zscExplainInjectFailure(messages) {
	let list = messages || [];
	let zh = zscIsZh();
	if (list.some(m => m.indexOf("no-window-global") === 0) || list.some(m => m.indexOf("detect-empty") === 0)) {
		return zh ? "发送失败：侧边栏页面还没就绪，稍等几秒再试（内容已复制）"
			: "Failed: the sidebar page isn't ready yet — retry in a moment (copied)";
	}
	if (list.some(m => m.indexOf("NO_COMPOSER") === 0)) {
		return zscT("noComposer") + (zh ? "（内容已复制）" : " (copied)");
	}
	if (list.some(m => m.indexOf("INSERT_FAILED") === 0)) {
		return zh ? "发送失败：文字没能写进输入框（内容已复制）" : "Failed: couldn't write into the input box (copied)";
	}
	if (list.some(m => m.indexOf("translate-timeout") === 0)) {
		return zh ? "发送超时（内容已复制）" : "Timed out (copied)";
	}
	return zh ? "发送失败（内容已复制到剪贴板）" : "Send failed (copied to clipboard)";
}

/** 有诊断诉求时把一行信息写到底部诊断区 */
function zscShowDiag(text) {
	try {
		if (ZSC?.panel?.diag && zscGetPref("showDiag", false)) {
			ZSC.panel.diag.textContent = text;
		}
	}
	catch (e) { /* ignore */ }
}

function zscSendPrompt(prompt, win) {
	let panel = ZSC.panel;
	if (!panel || !panel.browser) {
		// 面板还没建起来：记成"待开新对话"，等 onRender 之后再导航。
		// 不能复用 pendingPrompt —— 那个队列的语义是"注入当前对话"，两者会打架。
		ZSC.pendingNewChat = prompt;
		return;
	}
	let limit = parseInt(zscGetPref("maxChars", 6000), 10) || 6000;
	let { text, truncated } = zscTruncate(prompt, limit);
	let url = zscChatURL(text);
	panel.lastURL = url;
	panel.loaded = true;
	zscNavigate(panel.browser, url);

	if (truncated) {
		zscCopyToClipboard(prompt);
		zscSetStatus(zscT("sentTruncated"));
	}
	else {
		zscSetStatus(zscT("sentNew"));
	}
	if (zscGetPref("toastOnSend", true)) {
		zscToast(win || Zotero.getMainWindow(), truncated ? zscT("sentTruncated") : zscT("sentNew"));
	}
}

function zscEnsureVisible(options) {
	options = options || {};
	let win = Zotero.getMainWindow();
	if (!win) {
		return null;
	}

	// 之前这里会强制切到"文库"标签页，导致在 PDF 里划词时被弹走 —— 已去掉。
	// 这里还曾调 reader.toggleSidebar(true) 展开阅读器的侧栏，但那个侧栏在**左侧**
	// （缩略图/注释），划词发送时把它弹出来纯属打扰 —— 也已去掉。
	// 用户要的是**右侧栏**展开，那是下面这段（条目面板 + 插件 section）的事。

	// 展开被折叠的条目面板（右侧栏）
	try {
		let zp = win.ZoteroPane;
		if (zp && zp.itemPaneCollapsed) {
			zp.itemPaneCollapsed = false;
		}
	}
	catch (e) { /* ignore */ }

	// 展开我们的 section。
	// 注意：注册时 paneID 会被 Zotero 命名空间化（CSS.escape("<pluginID>-<paneID>")），
	// 所以 data-pane 并不是 "zoterogpt"，只能按后缀找。
	try {
		let section = zscFindSectionEl(win.document);
		if (section) {
			if (!section.open) {
				// 为了露出面板而展开（程序性展开，无发送副作用）
				zscSetSectionOpen(section, true);
			}
			if (section.scrollIntoView) {
				section.scrollIntoView({ block: "nearest" });
			}
		}
	}
	catch (e) { /* ignore */ }

	zscEnsureBrowserLoaded();
	return win;
}

/* ------------------------------------------------------------------ */
/* 划词 / 阅读器                                                       */
/* ------------------------------------------------------------------ */

function zscInjectReaderStyle(doc) {
	try {
		if (doc.getElementById("zsc-sel-style")) {
			return;
		}
		let style = doc.createElement("style");
		style.id = "zsc-sel-style";
		style.textContent = ZSC_SEL_CSS;
		(doc.head || doc.documentElement).appendChild(style);
	}
	catch (e) {
		zscError(e);
	}
}

function zscGetReaderSelection(reader) {
	try {
		let win = reader?._iframeWindow;
		if (win) {
			let selection = win.getSelection?.();
			let text = selection ? String(selection).trim() : "";
			if (text) {
				return text;
			}
		}
	}
	catch (e) { /* ignore */ }

	try {
		let internal = reader?._internalReader;
		let view = internal?._primaryView || internal?._lastView;
		let ranges = view?._selectionRanges;
		if (ranges && ranges[0]) {
			let text = String(ranges[0]?.toString?.() || "").trim();
			if (text) {
				return text;
			}
		}
	}
	catch (e) { /* ignore */ }
	return "";
}

function zscOnTextSelectionPopup(event) {
	let { doc, params, append } = event;
	if (!doc || !append) {
		return;
	}
	let text = String(params?.annotation?.text || "").trim();
	if (!text) {
		return;
	}
	zscInjectReaderStyle(doc);

	let box = doc.createElement("div");
	box.className = "zsc-sel-actions";
	let btn = doc.createElement("button");
	btn.className = "zsc-sel-btn";
	btn.textContent = zscT("sendToChat");
	btn.title = zscT("sendToChat");
	btn.addEventListener("click", (clickEvent) => {
		clickEvent.preventDefault();
		clickEvent.stopPropagation();
		// 不做任何包装，选中什么就原样发过去
		zscAsk(text);
	});
	box.appendChild(btn);
	append(box);
}

function zscOnViewContextMenu(event) {
	let { reader, append } = event;
	if (!append) {
		return;
	}
	let build = () => ({
		label: zscT("sendToChat"),
		onCommand: () => {
			let text = zscGetReaderSelection(reader);
			if (!text) {
				zscToast(Zotero.getMainWindow(), zscT("noText"));
				return;
			}
			zscAsk(text);
		},
	});
	append(build());

	// 右键菜单里也给一个「发送这本 PDF」——同样不切页
	append({
		label: zscT("sendPdf"),
		onCommand: () => zscSendPdf({ reader }),
	});
}

function registerReaderIntegration() {
	let handlers = [
		["renderTextSelectionPopup", zscOnTextSelectionPopup],
		// v1.5.3：不再往阅读器工具栏加按钮（ChatGPT / 📎 PDF）——与划词弹窗、
		// 右键菜单、面板标题栏的纸飞机按钮重复，用户要求去掉，还工具栏一个清净。
		["createViewContextMenu", zscOnViewContextMenu],
	];
	for (let [type, handler] of handlers) {
		try {
			Zotero.Reader.registerEventListener(type, handler, ZSC_ID);
			ZSC.readerHandlers.push([type, handler]);
		}
		catch (e) {
			zscError(e);
		}
	}
}

/* ------------------------------------------------------------------ */
/* 条目右键菜单                                                        */
/* ------------------------------------------------------------------ */

function zscSelectedItems() {
	try {
		let zp = Zotero.getActiveZoteroPane();
		return zp ? zp.getSelectedItems() : [];
	}
	catch (e) {
		return [];
	}
}

function zscTopLevel(item) {
	try {
		return item.parentItem || item;
	}
	catch (e) {
		return item;
	}
}

function zscItemVars(item) {
	let top = zscTopLevel(item);
	let field = (name) => {
		try {
			return top.getField(name) || "";
		}
		catch (e) {
			return "";
		}
	};
	let creators = "";
	try {
		creators = (top.getCreators() || [])
			.map((c) => [c.firstName, c.lastName].filter(Boolean).join(" "))
			.join(", ");
	}
	catch (e) { /* ignore */ }
	let publication = field("publicationTitle") || field("proceedingsTitle") || field("bookTitle") || field("publisher");
	return {
		title: field("title"),
		creators,
		date: field("date"),
		publication,
		abstract: field("abstractNote"),
	};
}

function zscAskItems(kind) {
	let items = zscSelectedItems();
	if (!items.length) {
		return;
	}
	let prompts = [];
	for (let item of items.slice(0, 5)) {
		prompts.push(zscBuildPrompt(kind, zscItemVars(item)));
	}
	zscAsk(prompts.join("\n\n---\n\n"));
}

function registerMenus() {
	try {
		if (Zotero.MenuManager?.registerMenu) {
			ZSC.menuID = Zotero.MenuManager.registerMenu({
				menuID: "zoterogpt-item-menu",
				pluginID: ZSC_ID,
				target: "main/library/item",
				menus: [
					{
						menuType: "menuitem",
						l10nID: "zoterogpt-menu-summarize",
						onCommand: () => zscAskItems("item"),
					},
					{
						menuType: "menuitem",
						l10nID: "zoterogpt-menu-questions",
						onCommand: () => zscAskItems("questions"),
					},
					{
						menuType: "menuitem",
						l10nID: "zoterogpt-menu-send-pdf",
						onCommand: () => zscSendPdf({}),
					},
					{
						menuType: "menuitem",
						l10nID: "zoterogpt-menu-open-tab",
						onCommand: () => zscOpenTab(),
					},
				],
			});
			zscLog("menu registered: " + ZSC.menuID);
		}
	}
	catch (e) {
		zscError(e);
		ZSC.menuID = null;
	}
}

/* ------------------------------------------------------------------ */
/* 偏好面板绑定 / 外部接口                                              */
/* ------------------------------------------------------------------ */

/** 切换服务后重新载入面板到该服务的站点 */
function zscSwitchProvider() {
	let prov = zscProv();
	zscLog("switch provider -> " + prov.id + " " + prov.url);
	let win = null;
	try { win = Zotero.getMainWindow(); } catch (e) { /* ignore */ }
	try {
		if (ZSC && ZSC.panel && ZSC.panel.browser) {
			zscNavigate(ZSC.panel.browser, prov.url);
			ZSC.panel.lastURL = prov.url;
		}
		if (win) {
			zscSetStatus((zscIsZh() ? "已切换到 " : "Switched to ") + prov.label + "…");
		}
	}
	catch (e) {
		zscError(e);
	}
}

function zscInitPrefPane(win) {
	try {
		let doc = win.document;
		let nodes = doc.querySelectorAll("[data-zsc-pref]");
		for (let node of nodes) {
			let name = node.getAttribute("data-zsc-pref");
			let type = node.getAttribute("data-zsc-type") || "string";
			let tag = String(node.localName || "").toLowerCase();
			let current = zscGetPref(name, type === "bool" ? false : (type === "int" ? 0 : ""));

			try {
				if (type === "bool") {
					node.checked = !!current;
				}
				else if (tag === "radiogroup") {
					zscSetRadioGroup(node, current);
				}
				else {
					node.value = String(current);
				}
			}
			catch (e) { /* ignore */ }

			let onChange = () => {
				try {
					if (type === "bool") {
						zscSetPref(name, !!node.checked);
					}
					else if (type === "int") {
						zscSetPref(name, parseInt(node.value, 10) || 0);
					}
					else if (tag === "radiogroup") {
						zscSetPref(name, node.value || "");
					}
					else {
						zscSetPref(name, node.value);
					}
				}
				catch (e) {
					zscError(e);
				}
			};
			node.addEventListener("change", onChange);
			node.addEventListener("input", onChange);
			node.addEventListener("command", onChange);
		}
		// 切换 AI 服务后把面板导航到对应站点，否则要重启 Zotero 才生效
		let provCtrl = doc.querySelector('[data-zsc-pref="provider"]');
		if (provCtrl && !provCtrl.__zscProvBound) {
			provCtrl.__zscProvBound = true;
			let apply = () => {
				try {
					zscSetProvider(String(provCtrl.value || ""));
				}
				catch (e) {
					zscError(e);
				}
			};
			// HTML <select> 走 change，XUL 控件走 command，两个都绑
			provCtrl.addEventListener("command", apply);
			provCtrl.addEventListener("change", apply);
		}
		zscLog("pref pane bound: " + nodes.length + " controls");
		zscBindZoomControls(win);
	}
	catch (e) {
		zscError(e);
	}
}

/**
 * 绑定设置面板里的缩放控件（A− / 百分比 / A+ / 重置）。
 *
 * zoom 在 pref 里存的是小数（0.85），界面上要显示百分比，走不了
 * `[data-zsc-pref]` 那套通用绑定，所以这里单独处理。
 */
function zscBindZoomControls(win) {
	try {
		let doc = win.document;
		let nodes = doc.querySelectorAll("[data-zsc-zoom]");
		if (!nodes || !nodes.length) {
			return;
		}
		let sync = () => {
			let text = zscZoomPercent();
			for (let node of nodes) {
				if (node.getAttribute("data-zsc-zoom") === "value") {
					try {
						node.value = text;
					}
					catch (e) { /* ignore */ }
				}
			}
		};
		for (let node of nodes) {
			let role = node.getAttribute("data-zsc-zoom");
			if (role === "value") {
				continue;
			}
			let onClick = () => {
				try {
					if (role === "out") {
						zscZoomStep(-ZSC_ZOOM_STEP);
					}
					else if (role === "in") {
						zscZoomStep(ZSC_ZOOM_STEP);
					}
					else {
						zscZoomSet(1);
					}
				}
				catch (e) {
					zscError(e);
				}
			};
			node.addEventListener("click", onClick);
			node.addEventListener("command", onClick);
		}
		sync();
		if (!ZSC.zoomListeners) {
			ZSC.zoomListeners = [];
		}
		// 换掉同一个窗口上次开的回调，避免反复打开设置窗口后越堆越多
		ZSC.zoomListeners = ZSC.zoomListeners.filter(item => item && item.win !== win);
		ZSC.zoomListeners.push({ win, fn: sync });
		zscLog("zoom controls bound: " + nodes.length);
	}
	catch (e) {
		zscError(e);
	}
}

function zscSetRadioGroup(group, value) {
	try {
		group.value = value;
		if (group.value === value) {
			return;
		}
	}
	catch (e) { /* ignore */ }
	try {
		for (let radio of group.querySelectorAll("radio, html\\:input")) {
			if (radio.value === value) {
				radio.setAttribute("selected", "true");
			}
			else {
				radio.removeAttribute("selected");
			}
		}
	}
	catch (e) { /* ignore */ }
}

function zscOpenPanel() {
	return zscEnsureVisible();
}

function zscGetPanelState() {
	let cookies = zscCookieStatus();
	return {
		mounted: !!ZSC?.panel,
		mounts: ZSC?.mounts || 0,
		loaded: !!ZSC?.panel?.loaded,
		lastURL: ZSC?.panel?.lastURL || null,
		currentURL: (() => {
			try {
				return ZSC?.panel?.browser?.currentURI?.spec || null;
			}
			catch (e) {
				return null;
			}
		})(),
		cookieCount: cookies.count,
		hasSessionCookie: cookies.session,
		cookieError: cookies.error,
		prefs: {
			chatUrl: zscGetPref("chatUrl", ""),
			sendMode: zscGetPref("sendMode", ""),
			stripFrameHeaders: zscGetPref("stripFrameHeaders", true),
			maxChars: zscGetPref("maxChars", 3000),
		},
	};
}

/* ------------------------------------------------------------------ */
/* 网络：剥离 X-Frame-Options / CSP frame-ancestors                     */
/* ------------------------------------------------------------------ */

function zscChannelIsOurs(channel) {
	try {
		let bc = channel.loadInfo?.browsingContext;
		let panelBC = ZSC?.panel?.browser?.browsingContext;
		if (bc && panelBC) {
			return bc.top === panelBC.top;
		}
	}
	catch (e) { /* ignore */ }
	return null;
}

function zscStripFrameHeaders(channel) {
	let ours = zscChannelIsOurs(channel);
	if (ours === false) {
		return;
	}
	if (!zscGetPref("stripFrameHeaders", true)) {
		return;
	}
	// X-Frame-Options
	try {
		channel.setResponseHeader("X-Frame-Options", "", false);
	}
	catch (e) { /* 头不存在 */ }

	// CSP 里的 frame-ancestors
	for (let header of ["Content-Security-Policy", "Content-Security-Policy-Report-Only"]) {
		let value = null;
		try {
			value = channel.getResponseHeader(header);
		}
		catch (e) {
			continue;
		}
		if (!value) {
			continue;
		}
		if (!/frame-ancestors/i.test(value)) {
			continue;
		}
		let cleaned = value
			.split(";")
			.filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
			.join(";");
		try {
			channel.setResponseHeader(header, cleaned, false);
		}
		catch (e) { /* ignore */ }
	}
}

function zscMaybeOverrideUA(channel) {
	if (!zscGetPref("plainUserAgent", true)) {
		return;
	}
	let ua = String(zscGetPref("customUserAgent", "") || "").trim() || zscPlainUA();
	let ours = zscChannelIsOurs(channel);
	if (ours === false) {
		return;
	}
	try {
		channel.setRequestHeader("User-Agent", ua, false);
	}
	catch (e) { /* ignore */ }
}

function startHttpObserver() {
	try {
		ZSC.httpObserver = {
			observe(subject, topic) {
				try {
					let channel = subject.QueryInterface(Ci.nsIHttpChannel);
					let host = channel.URI?.host || "";
					if (topic === "http-on-modify-request") {
						if (zscIsChatHost(host)) {
							zscMaybeOverrideUA(channel);
						}
					}
					else if (topic === "http-on-examine-response") {
						if (zscIsChatHost(host)) {
							let status = 0;
							try {
								status = channel.responseStatus;
							}
							catch (e) { /* ignore */ }
							let isDoc = false;
							try {
								isDoc = channel.loadInfo?.externalContentPolicyType
									=== Ci.nsIContentPolicy.TYPE_DOCUMENT;
							}
							catch (e) { /* ignore */ }
							if (isDoc || status >= 400) {
								zscLogHttp("http " + status + " " + String(channel.URI?.spec || "").slice(0, 200));
							}
							zscStripFrameHeaders(channel);
						}
					}
				}
				catch (e) {
					// 静默：不影响正常网络请求
				}
			},
		};
		Services.obs.addObserver(ZSC.httpObserver, "http-on-examine-response");
		Services.obs.addObserver(ZSC.httpObserver, "http-on-modify-request");
		zscLog("http observer started");
	}
	catch (e) {
		zscError(e);
	}
}

function stopHttpObserver() {
	try {
		if (ZSC?.httpObserver) {
			Services.obs.removeObserver(ZSC.httpObserver, "http-on-examine-response");
			Services.obs.removeObserver(ZSC.httpObserver, "http-on-modify-request");
			ZSC.httpObserver = null;
		}
	}
	catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 面板 DOM 模板                                                       */
/* ------------------------------------------------------------------ */

const ZSC_PANEL_MARKUP = `
<html:div id="zsc-root" class="zsc-root" xmlns:html="${XHTML_NS}">
	<html:div id="zsc-browser-host" class="zsc-browser-host"></html:div>
	<html:div id="zsc-resizer" class="zsc-resizer" title="拖动调整高度"></html:div>
	<html:div id="zsc-hint" class="zsc-hint"></html:div>
	<html:div id="zsc-diag" class="zsc-diag"></html:div>
</html:div>
`;
