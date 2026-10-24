import { escapeHtml, renderMarkdown } from "./markdown.js";

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const STORAGE_KEY = "pi-dock:settings";
const DEFAULT_SETTINGS = { ctrlEnterSend: true, theme: "system" };
const THEMES = ["system", "light", "dark"];
const MAX_TOOL_OUTPUT = 40_000;

const $ = (id) => document.getElementById(id);
const dom = {
	input: $("input"),
	sendButton: $("sendButton"),
	stopButton: $("stopButton"),
	composer: $("composer"),
	composerLeft: $("composerLeft"),
	commandButton: $("commandButton"),
	commandMenu: $("commandMenu"),
	imageButton: $("imageButton"),
	imageInput: $("imageInput"),
	attachments: $("attachments"),
	sendMode: $("sendMode"),
	planPanel: $("planPanel"),
	planTitle: $("planTitle"),
	planCurrent: $("planCurrent"),
	planItems: $("planItems"),
	queueBadge: $("queueBadge"),
	scroller: $("scroller"),
	messageList: $("messageList"),
	liveMount: $("liveMount"),
	runStatus: $("runStatus"),
	empty: $("empty"),
	jumpButton: $("jumpButton"),
	projectName: $("projectName"),
	sessionName: $("sessionName"),
	modelButton: $("modelButton"),
	modelLabel: $("modelLabel"),
	thinkingButton: $("thinkingButton"),
	thinkingLabel: $("thinkingLabel"),
	contextButton: $("contextButton"),
	ringFg: $("ringFg"),
	newChatButton: $("newChatButton"),
	historyButton: $("historyButton"),
	settingsButton: $("settingsButton"),
	slashMenu: $("slashMenu"),
	modelMenu: $("modelMenu"),
	thinkingMenu: $("thinkingMenu"),
	settingsMenu: $("settingsMenu"),
	contextMenu: $("contextMenu"),
	historyPanel: $("historyPanel"),
	historyClose: $("historyClose"),
	drawerBackdrop: $("drawerBackdrop"),
	sessionList: $("sessionList"),
	dialogLayer: $("dialogLayer"),
	dialog: $("dialog"),
	toasts: $("toasts"),
	widgets: $("widgets"),
	banner: $("banner"),
	bannerText: $("bannerText"),
	bannerAction: $("bannerAction"),
};

const settings = loadSettings();
const state = {
	ready: false,
	connected: false,
	piDown: "",
	running: false,
	compacting: false,
	aborting: false,
	retry: null,
	cwd: "",
	sessionName: "",
	sessionId: "",
	model: null,
	thinkingLevel: "off",
	models: [],
	levels: ["off"],
	commands: [],
	messages: [],
	plan: null,
	attachments: [],
	live: null,
	tools: {},
	toolRev: {},
	stats: null,
	sessionState: null,
	queue: { steering: [], followUp: [] },
	statuses: {},
	widgets: {},
	dialogs: [],
	sessions: [],
	menu: null,
	slash: null,
	commandMenu: null,
	sendMode: "steer",
};

const openKeys = new Set();
const messageNodes = new Map();
const listeners = { extTimers: new WeakMap() };

let stickToBottom = true;
let liveFrame = 0;
let messagesFrame = 0;
let statsTimer = 0;
let composing = false;
let compositionEndedAt = Number.NEGATIVE_INFINITY;

/* ------------------------------------------------------------------ setup */

function loadSettings() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
		return {
			...DEFAULT_SETTINGS,
			ctrlEnterSend: parsed.ctrlEnterSend !== false,
			theme: THEMES.includes(parsed.theme) ? parsed.theme : "system",
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function saveSettings() {
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ ctrlEnterSend: settings.ctrlEnterSend, theme: settings.theme }),
		);
	} catch {
		/* storage may be unavailable */
	}
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
	const resolved =
		settings.theme === "system" ? (darkQuery.matches ? "dark" : "light") : settings.theme;
	document.documentElement.dataset.theme = resolved;
}

function onSystemSchemeChange() {
	if (settings.theme === "system") applyTheme();
}

if (darkQuery.addEventListener) darkQuery.addEventListener("change", onSystemSchemeChange);
else darkQuery.addListener(onSystemSchemeChange);

async function api(command) {
	const response = await fetch("/api/rpc", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-pi-dock-token": TOKEN,
		},
		body: JSON.stringify(command),
	});
	let body;
	try {
		body = await response.json();
	} catch {
		throw new Error(`HTTP ${response.status}`);
	}
	if (!body?.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
	return body.data;
}

function connect() {
	const events = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
	events.onopen = () => {
		const wasDown = !state.connected;
		state.connected = true;
		if (wasDown && state.ready) refreshSnapshot().catch(() => {});
		renderChrome();
	};
	events.onerror = () => {
		state.connected = false;
		renderChrome();
	};
	events.onmessage = (event) => {
		let record;
		try {
			record = JSON.parse(event.data);
		} catch {
			return;
		}
		handleRecord(record);
	};
}

async function refreshSnapshot() {
	const snapshot = await api({ type: "dock:snapshot" });
	state.cwd = snapshot.cwd ?? "";
	state.sessionState = snapshot.state ?? null;
	state.model = snapshot.state?.model ?? null;
	state.thinkingLevel = snapshot.state?.thinkingLevel ?? "off";
	state.sessionName = snapshot.state?.sessionName ?? "";
	state.sessionId = snapshot.state?.sessionId ?? "";
	state.running = Boolean(snapshot.state?.isStreaming);
	state.compacting = Boolean(snapshot.state?.isCompacting);
	state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
	state.stats = snapshot.stats ?? null;
	state.models = snapshot.models ?? [];
	state.levels = snapshot.levels?.length ? snapshot.levels : ["off"];
	state.commands = snapshot.commands ?? [];
	state.plan = snapshot.plan ?? null;
	state.attachments = [];
	renderAttachments();
	state.live = snapshot.live?.blocks?.length
		? { blocks: snapshot.live.blocks, tools: snapshot.live.tools ?? {} }
		: null;
	state.tools = {};
	state.toolRev = {};
	for (const tool of Object.values(snapshot.live?.tools ?? {})) {
		state.tools[tool.id] = tool;
	}
	state.queue = { steering: [], followUp: [] };
	state.retry = null;
	state.aborting = false;
	state.ready = true;
	state.piDown = "";
	openKeys.clear();
	messageNodes.clear();
	dom.messageList.innerHTML = "";
	stickToBottom = true;
	renderChrome();
	renderMessages(true);
	renderLive();
	renderPlan();
	renderRunStatus();
	scrollToBottom(true);
}

/* ---------------------------------------------------------------- events */

function handleRecord(record) {
	switch (record.type) {
		case "dock:hello":
			return;
		case "dock:exit":
			state.piDown = record.reason ?? "Pi との接続が切れました";
			state.running = false;
			state.compacting = false;
			state.live = null;
			state.aborting = false;
			renderChrome();
			renderLive();
			renderRunStatus();
			return;
		case "dock:plan":
			state.plan = record.plan ?? null;
			renderPlan();
			return;
		case "agent_start":
			state.running = true;
			state.aborting = false;
			state.retry = null;
			state.sendMode = "steer";
			state.live = { blocks: [], tools: state.tools };
			renderChrome();
			scheduleLive();
			return;
		case "agent_end":
			return;
		case "agent_settled":
			state.running = false;
			state.aborting = false;
			state.retry = null;
			state.sendMode = "steer";
			state.live = null;
			state.tools = {};
			state.toolRev = {};
			renderChrome();
			scheduleLive();
			renderMessages();
			scheduleStats();
			return;
		case "message_start":
			onMessageStart(record.message);
			return;
		case "message_update":
			onMessageUpdate(record.assistantMessageEvent);
			return;
		case "message_end":
			onMessageEnd(record.message);
			return;
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			onToolEvent(record);
			return;
		case "queue_update":
			state.queue = {
				steering: record.steering ?? [],
				followUp: record.followUp ?? [],
			};
			renderChrome();
			return;
		case "thinking_level_changed":
			state.thinkingLevel = record.level ?? state.thinkingLevel;
			renderChrome();
			return;
		case "session_info_changed":
			state.sessionName = record.name ?? "";
			renderChrome();
			return;
		case "compaction_start":
			state.compacting = true;
			renderRunStatus();
			return;
		case "compaction_end":
			state.compacting = false;
			renderRunStatus();
			scheduleStats();
			return;
		case "auto_retry_start":
			state.retry = { attempt: record.attempt, maxAttempts: record.maxAttempts };
			renderRunStatus();
			return;
		case "auto_retry_end":
			state.retry = null;
			renderRunStatus();
			return;
		case "extension_ui_request":
			onExtensionUi(record);
			return;
		case "extension_error":
			toast(record.error ?? "拡張でエラーが発生しました", "error");
			return;
		default:
			return;
	}
}

function onMessageStart(message) {
	if (!message) return;
	if (message.role === "user") {
		onUserMessage(message, { start: true });
		renderMessages();
	} else if (message.role === "assistant") {
		state.live = { blocks: [], tools: state.tools };
		scheduleLive();
	}
}

function onMessageUpdate(update) {
	if (!update) return;
	if (!state.live) state.live = { blocks: [], tools: state.tools };
	const blocks = state.live.blocks;
	const index = update.contentIndex ?? 0;
	const current = blocks[index];
	switch (update.type) {
		case "text_start":
			blocks[index] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (current?.type === "text") current.text += update.delta;
			break;
		case "text_end":
			blocks[index] = { type: "text", text: update.content ?? "" };
			break;
		case "thinking_start":
			blocks[index] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (current?.type === "thinking") current.thinking += update.delta;
			break;
		case "thinking_end":
			blocks[index] = { type: "thinking", thinking: update.content ?? "" };
			break;
		case "toolcall_start":
			blocks[index] = {
				type: "toolCall",
				id: update.id,
				name: update.toolName,
				arguments: {},
				partialArgs: "",
			};
			break;
		case "toolcall_delta":
			if (current?.type === "toolCall") current.partialArgs += update.delta;
			break;
		case "toolcall_end":
			blocks[index] = {
				type: "toolCall",
				id: update.toolCall?.id ?? current?.id,
				name: update.toolCall?.name ?? current?.name,
				arguments: update.toolCall?.arguments ?? {},
			};
			break;
		default:
			return;
	}
	scheduleLive();
	scrollToBottom();
}

function onMessageEnd(message) {
	if (!message) return;
	if (message.role === "user") {
		onUserMessage(message);
	} else if (message.role === "assistant") {
		const last = state.messages[state.messages.length - 1];
		if (!(last?.role === "assistant" && last.timestamp === message.timestamp)) {
			state.messages.push(message);
		}
		state.live = null;
		scheduleLive();
	} else if (message.role === "toolResult") {
		const exists = state.messages.some(
			(item) => item.role === "toolResult" && item.toolCallId === message.toolCallId,
		);
		if (!exists) state.messages.push(message);
	} else if (["bashExecution", "compactionSummary", "branchSummary", "custom"].includes(message.role)) {
		state.messages.push(message);
	}
	renderMessages();
	scheduleStats();
	scrollToBottom();
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function onUserMessage(message, { start = false } = {}) {
	for (let index = state.messages.length - 1; index >= 0; index -= 1) {
		const item = state.messages[index];
		if (item.role === "user" && item._optimistic) {
			state.messages[index] = { ...message, _optimistic: false };
			state.pendingUser = start ? textOfContent(message.content) : null;
			return;
		}
	}
	if (!start && state.pendingUser !== null && state.pendingUser === textOfContent(message.content)) {
		state.pendingUser = null;
		return;
	}
	state.messages.push(message);
	state.pendingUser = start ? textOfContent(message.content) : null;
}

function onToolEvent(record) {
	const id = record.toolCallId;
	if (!id) return;
	const existing = state.tools[id];
	if (record.type === "tool_execution_start") {
		state.tools[id] = {
			id,
			name: record.toolName,
			args: record.args,
			status: "running",
			output: "",
		};
	} else if (record.type === "tool_execution_update") {
		if (existing) existing.output = toolText(record.partialResult);
	} else {
		const tool = existing ?? { id, name: record.toolName, args: record.args };
		tool.status = record.isError ? "error" : "done";
		tool.isError = Boolean(record.isError);
		tool.output = toolText(record.result) || tool.output || "";
		tool.durationMs = record.durationMs;
		state.tools[id] = tool;
	}
	state.toolRev[id] = (state.toolRev[id] ?? 0) + 1;
	scheduleLive();
	scheduleMessages();
}

function toolText(result) {
	if (!result) return "";
	if (typeof result === "string") return result;
	const content = result.content ?? result.partialResult?.content ?? [];
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/* -------------------------------------------------------------- extension */

function onExtensionUi(request) {
	switch (request.method) {
		case "notify":
			toast(request.message ?? "", request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info");
			return;
		case "setStatus":
			if (request.statusText) state.statuses[request.statusKey] = request.statusText;
			else delete state.statuses[request.statusKey];
			renderChrome();
			return;
		case "setWidget": {
			const key = request.widgetKey ?? "widget";
			if (Array.isArray(request.widgetLines) && request.widgetLines.length) {
				state.widgets[key] = request.widgetLines.join("\n");
			} else {
				delete state.widgets[key];
			}
			renderWidgets();
			return;
		}
		case "setTitle":
			document.title = request.title || "pi-dock";
			return;
		case "set_editor_text":
			if (typeof request.text === "string") {
				dom.input.value = request.text;
				autosize();
				updateSendButton();
			}
			return;
		case "select":
		case "confirm":
		case "input":
		case "editor":
			enqueueDialog(request);
			return;
		default:
			return;
	}
}

function enqueueDialog(request) {
	state.dialogs.push(request);
	if (typeof request.timeout === "number") {
		const timer = setTimeout(() => {
			if (state.dialogs.includes(request)) respondDialog(request, { cancelled: true });
		}, request.timeout + 250);
		listeners.extTimers.set(request, timer);
	}
	renderDialog();
}

function respondDialog(request, response) {
	const timer = listeners.extTimers.get(request);
	if (timer) clearTimeout(timer);
	listeners.extTimers.delete(request);
	state.dialogs = state.dialogs.filter((item) => item !== request);
	renderDialog();
	api({ type: "dock:extension_ui_response", id: request.id, ...response }).catch((error) => {
		toast(error.message, "error");
	});
}

function renderDialog() {
	const request = state.dialogs[0];
	if (!request) {
		dom.dialogLayer.hidden = true;
		dom.dialog.replaceChildren();
		return;
	}
	dom.dialogLayer.hidden = false;
	const parts = [];
	const h2 = document.createElement("h2");
	h2.textContent = request.title || "確認";
	parts.push(h2);

	if (request.method === "confirm") {
		const p = document.createElement("p");
		p.textContent = request.message ?? "";
		parts.push(p);
		const actions = document.createElement("div");
		actions.className = "dialog-actions";
		actions.append(
			button("キャンセル", "btn", () => respondDialog(request, { confirmed: false })),
			button("はい", "btn primary", () => respondDialog(request, { confirmed: true })),
		);
		parts.push(actions);
	} else if (request.method === "select") {
		const list = document.createElement("div");
		list.className = "dialog-options";
		for (const option of request.options ?? []) {
			const item = button(option, "btn option", () => respondDialog(request, { value: option }));
			list.append(item);
		}
		parts.push(list);
		parts.push(
			button("キャンセル", "btn", () => respondDialog(request, { cancelled: true }), "dialog-cancel"),
		);
	} else if (request.method === "input") {
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = request.placeholder ?? "";
		input.dataset.role = "dialog-input";
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				respondDialog(request, { value: input.value });
			}
		});
		parts.push(input);
		parts.push(
			dialogActions(
				() => respondDialog(request, { cancelled: true }),
				() => respondDialog(request, { value: input.value }),
			),
		);
	} else if (request.method === "editor") {
		const textarea = document.createElement("textarea");
		textarea.rows = 8;
		textarea.value = request.prefill ?? "";
		textarea.dataset.role = "dialog-input";
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
				event.preventDefault();
				respondDialog(request, { value: textarea.value });
			}
		});
		parts.push(textarea);
		parts.push(
			dialogActions(
				() => respondDialog(request, { cancelled: true }),
				() => respondDialog(request, { value: textarea.value }),
			),
		);
	}

	dom.dialog.replaceChildren(...parts);
	const focusable = dom.dialog.querySelector("input, textarea, .btn.option, .btn.primary, .btn");
	focusable?.focus();
}

function button(label, className, onClick, testId) {
	const element = document.createElement("button");
	element.type = "button";
	element.className = className;
	element.textContent = label;
	if (testId) element.dataset.testid = testId;
	element.addEventListener("click", onClick);
	return element;
}

function dialogActions(onCancel, onConfirm) {
	const actions = document.createElement("div");
	actions.className = "dialog-actions";
	actions.append(
		button("キャンセル", "btn", onCancel),
		button("OK", "btn primary", onConfirm),
	);
	return actions;
}

/* ---------------------------------------------------------------- actions */

async function send() {
	const text = dom.input.value.trim();
	if (!text) return;
	if (!state.ready) {
		toast("Pi に接続されていません", "error");
		return;
	}
	closeSlash();
	closeMenus();
	closeCommandMenu();
	const images = state.attachments.map((attachment) => ({
		type: "image",
		data: attachment.data,
		mimeType: attachment.mimeType,
	}));
	const command = { type: "prompt", message: text };
	if (images.length) command.images = images;
	if (state.running) {
		command.streamingBehavior = state.sendMode === "followUp" ? "followUp" : "steer";
	}
	const content = images.length ? [{ type: "text", text }, ...images] : text;
	const restore = images.length ? state.attachments.slice() : [];
	state.messages.push({
		role: "user",
		content,
		timestamp: Date.now(),
		_optimistic: true,
	});
	dom.input.value = "";
	clearAttachments();
	autosize();
	updateSendButton();
	renderMessages();
	scrollToBottom(true);
	try {
		await api(command);
	} catch (error) {
		toast(error.message, "error");
		if (!dom.input.value.trim()) {
			dom.input.value = text;
			autosize();
			updateSendButton();
		}
		if (restore.length && !state.attachments.length) {
			state.attachments = restore;
			renderAttachments();
		}
		const index = state.messages.findIndex(
			(message) => message._optimistic && textOfContent(message.content) === text,
		);
		if (index !== -1) state.messages.splice(index, 1);
		renderMessages();
	}
}

async function abort() {
	if (!state.running || state.aborting) return;
	state.aborting = true;
	renderRunStatus();
	renderChrome();
	try {
		const queued = await api({ type: "clear_queue" }).catch(() => null);
		const restored = [...(queued?.steering ?? []), ...(queued?.followUp ?? [])];
		if (restored.length) {
			for (const text of restored) {
				const index = state.messages.findIndex(
					(message) =>
						message.role === "user" && message._optimistic && textOfContent(message.content) === text,
				);
				if (index !== -1) state.messages.splice(index, 1);
			}
			renderMessages();
			dom.input.value = dom.input.value.trim()
				? `${dom.input.value.trimEnd()}\n${restored.join("\n")}`
				: restored.join("\n");
			autosize();
			updateSendButton();
		}
		await api({ type: "abort" });
	} catch (error) {
		toast(error.message, "error");
	} finally {
		state.aborting = false;
		state.queue = { steering: [], followUp: [] };
		renderRunStatus();
		renderChrome();
	}
}

async function newChat() {
	closeMenus();
	closeHistory();
	if (state.running) await abort();
	try {
		const result = await api({ type: "new_session" });
		if (result?.cancelled) {
			toast("新しい会話はキャンセルされました", "warning");
			return;
		}
		await refreshSnapshot();
		dom.input.focus();
	} catch (error) {
		toast(error.message, "error");
	}
}

async function switchSession(path) {
	if (state.running) await abort();
	try {
		const result = await api({ type: "switch_session", sessionPath: path });
		if (result?.cancelled) {
			toast("切り替えはキャンセルされました", "warning");
			return;
		}
		closeHistory();
		await refreshSnapshot();
		dom.input.focus();
	} catch (error) {
		toast(error.message, "error");
	}
}

async function setModel(model) {
	closeMenus();
	try {
		await api({ type: "set_model", provider: model.provider, modelId: model.id });
		await refreshSnapshot();
	} catch (error) {
		toast(error.message, "error");
	}
}

async function setThinkingLevel(level) {
	closeMenus();
	state.thinkingLevel = level;
	renderChrome();
	try {
		await api({ type: "set_thinking_level", level });
	} catch (error) {
		toast(error.message, "error");
	}
}

function scheduleStats() {
	clearTimeout(statsTimer);
	statsTimer = setTimeout(() => {
		api({ type: "get_session_stats" })
			.then((stats) => {
				state.stats = stats;
				renderChrome();
				if (state.menu === "context") renderContextMenu();
			})
			.catch(() => {});
	}, 250);
}

/* --------------------------------------------------------------- composer */

function autosize() {
	dom.input.style.height = "auto";
	const max = Math.max(80, window.innerHeight * 0.38);
	dom.input.style.height = `${Math.min(dom.input.scrollHeight, max)}px`;
}

function updateSendButton() {
	const hasText = Boolean(dom.input.value.trim());
	dom.sendButton.disabled = !hasText || !state.ready;
	dom.stopButton.hidden = !state.running;
	dom.sendButton.hidden = state.running && !hasText;
}

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_DATA = 10 * 1024 * 1024;
let attachmentSequence = 0;

function readAsDataURL(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () => reject(reader.error ?? new Error("画像を読み込めません"));
		reader.readAsDataURL(file);
	});
}

async function addImageFiles(files) {
	const images = [...files].filter((file) => file.type?.startsWith("image/"));
	if (!images.length) return;
	let total = state.attachments.reduce((sum, attachment) => sum + attachment.data.length, 0);
	for (const file of images) {
		if (state.attachments.length >= MAX_ATTACHMENTS) {
			toast(`画像は ${MAX_ATTACHMENTS} 枚までです`, "warning");
			break;
		}
		try {
			const url = await readAsDataURL(file);
			const separator = url.indexOf(",");
			if (separator === -1) continue;
			const data = url.slice(separator + 1);
			if (total + data.length > MAX_ATTACHMENT_DATA) {
				toast("画像が大きすぎます", "warning");
				continue;
			}
			state.attachments.push({
				id: `image-${++attachmentSequence}`,
				name: file.name || "image",
				mimeType: file.type || "image/png",
				data,
				url,
			});
			total += data.length;
		} catch (error) {
			toast(error.message, "error");
		}
	}
	renderAttachments();
}

function renderAttachments() {
	dom.attachments.hidden = state.attachments.length === 0;
	dom.attachments.replaceChildren(
		...state.attachments.map((attachment) => {
			const item = document.createElement("div");
			item.className = "attachment";
			item.dataset.testid = "attachment";
			const image = document.createElement("img");
			image.src = attachment.url;
			image.alt = attachment.name;
			image.title = attachment.name;
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "attachment-remove";
			remove.dataset.id = attachment.id;
			remove.dataset.testid = "attachment-remove";
			remove.setAttribute("aria-label", "画像を削除");
			remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>';
			item.append(image, remove);
			return item;
		}),
	);
}

function clearAttachments() {
	state.attachments = [];
	renderAttachments();
}

dom.imageButton.addEventListener("click", () => dom.imageInput.click());
dom.imageInput.addEventListener("change", () => {
	addImageFiles(dom.imageInput.files ?? []);
	dom.imageInput.value = "";
});

dom.attachments.addEventListener("click", (event) => {
	const remove = event.target.closest("[data-id]");
	if (!remove) return;
	state.attachments = state.attachments.filter((attachment) => attachment.id !== remove.dataset.id);
	renderAttachments();
});

dom.input.addEventListener("paste", (event) => {
	const clipboard = event.clipboardData;
	const files = clipboard?.files?.length
		? [...clipboard.files]
		: [...(clipboard?.items ?? [])]
				.filter((item) => item.kind === "file")
				.map((item) => item.getAsFile())
				.filter(Boolean);
	const images = files.filter((file) => file.type.startsWith("image/"));
	if (!images.length) return;
	event.preventDefault();
	addImageFiles(images);
});

dom.composer.addEventListener("dragover", (event) => {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	dom.composer.classList.add("dragging");
});

dom.composer.addEventListener("dragleave", () => dom.composer.classList.remove("dragging"));

dom.composer.addEventListener("drop", (event) => {
	if (!event.dataTransfer?.files?.length) return;
	event.preventDefault();
	dom.composer.classList.remove("dragging");
	addImageFiles(event.dataTransfer.files);
});

function renderSendMode() {
	dom.sendMode.hidden = !state.running;
	for (const buttonElement of dom.sendMode.querySelectorAll("[data-send-mode]")) {
		buttonElement.setAttribute(
			"aria-pressed",
			String(buttonElement.dataset.sendMode === state.sendMode),
		);
	}
}

dom.sendMode.addEventListener("click", (event) => {
	const buttonElement = event.target.closest("[data-send-mode]");
	if (!buttonElement) return;
	state.sendMode = buttonElement.dataset.sendMode === "followUp" ? "followUp" : "steer";
	renderSendMode();
});

function isImeSubmit(event, now = performance.now()) {
	if (event.isComposing || event.keyCode === 229 || composing) return true;
	return now - compositionEndedAt < 120;
}

dom.input.addEventListener("compositionstart", () => {
	composing = true;
});

dom.input.addEventListener("compositionend", () => {
	composing = false;
	compositionEndedAt = performance.now();
});

dom.input.addEventListener("input", () => {
	autosize();
	updateSendButton();
	updateSlash();
});

dom.input.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		if (state.slash) {
			event.preventDefault();
			event.stopPropagation();
			closeSlash();
			return;
		}
		if (state.running) {
			event.preventDefault();
			event.stopPropagation();
			abort();
		}
		return;
	}

	if (event.key === "Enter") {
		if (isImeSubmit(event)) return;
		const menu = state.slash;
		if (menu && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			chooseSlash(menu.items[menu.index]);
			return;
		}
		if (event.ctrlKey || event.metaKey) {
			if (settings.ctrlEnterSend && !event.repeat) {
				event.preventDefault();
				send();
			}
			return;
		}
		return;
	}

	if (state.slash && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
		event.preventDefault();
		const items = state.slash.items;
		if (!items.length) return;
		const delta = event.key === "ArrowDown" ? 1 : -1;
		state.slash.index = (state.slash.index + delta + items.length) % items.length;
		renderSlash();
		return;
	}

	if (state.slash && event.key === "Tab") {
		event.preventDefault();
		chooseSlash(state.slash.items[state.slash.index]);
	}
});

dom.sendButton.addEventListener("click", () => send());
dom.stopButton.addEventListener("click", () => abort());

document.addEventListener("pointerdown", (event) => {
	if (
		state.commandMenu &&
		!dom.commandMenu.contains(event.target) &&
		!dom.commandButton.contains(event.target)
	) {
		closeCommandMenu();
	}
	if (!state.menu) return;
	if (
		dom.modelMenu.contains(event.target) ||
		dom.thinkingMenu.contains(event.target) ||
		dom.settingsMenu.contains(event.target) ||
		dom.contextMenu.contains(event.target) ||
		dom.modelButton.contains(event.target) ||
		dom.thinkingButton.contains(event.target) ||
		dom.settingsButton.contains(event.target) ||
		dom.contextButton.contains(event.target)
	) {
		return;
	}
	closeMenus();
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (state.dialogs.length) {
		event.preventDefault();
		respondDialog(state.dialogs[0], { cancelled: true });
		return;
	}
	if (state.commandMenu) {
		event.preventDefault();
		closeCommandMenu();
		return;
	}
	if (state.menu) {
		event.preventDefault();
		closeMenus();
		return;
	}
	if (!dom.historyPanel.hidden) {
		event.preventDefault();
		closeHistory();
		return;
	}
	if (state.running) {
		event.preventDefault();
		abort();
	}
});

window.addEventListener("resize", () => {
	if (state.menu) closeMenus();
	if (state.commandMenu) closeCommandMenu();
});

/* -------------------------------------------------------------- slash menu */

function updateSlash() {
	const value = dom.input.value;
	const match = /^\/([^\s]*)$/.exec(value);
	if (!match) {
		closeSlash();
		return;
	}
	const query = match[1].toLowerCase();
	const items = state.commands.filter((command) => {
		if (!query) return true;
		return (
			command.name.toLowerCase().includes(query) ||
			(command.description ?? "").toLowerCase().includes(query)
		);
	});
	if (!items.length) {
		closeSlash();
		return;
	}
	state.slash = { items: items.slice(0, 8), index: 0 };
	renderSlash();
}

function renderSlash() {
	const menu = state.slash;
	if (!menu) return;
	const items = menu.items
		.map((command, index) => {
			const icon = command.source === "skill" ? "i-spark" : command.source === "extension" ? "i-extension" : "i-prompt";
			return `<button type="button" class="menu-item${index === menu.index ? " active" : ""}" data-index="${index}" data-testid="slash-item">
				<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>
				<span class="cmd-name">/${escapeHtml(command.name)}</span>
				<span class="cmd-desc">${escapeHtml(command.description ?? "")}</span>
			</button>`;
		})
		.join("");
	dom.slashMenu.innerHTML = items;
	dom.slashMenu.hidden = false;
	dom.slashMenu.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
}

function closeSlash() {
	state.slash = null;
	dom.slashMenu.hidden = true;
	dom.slashMenu.replaceChildren();
}

function insertCommand(command) {
	if (!command) return;
	dom.input.value = `/${command.name} `;
	autosize();
	updateSendButton();
	dom.input.focus();
}

function chooseSlash(command) {
	if (!command) return;
	closeSlash();
	insertCommand(command);
}

function commandSourceLabel(source) {
	if (source === "skill") return "Skill";
	if (source === "extension") return "Extension";
	if (source === "prompt" || source === "template") return "Prompt";
	return "Command";
}

function commandSourceIcon(source) {
	if (source === "skill") return "i-spark";
	if (source === "extension") return "i-extension";
	return "i-prompt";
}

function filterCommands(query) {
	const value = query.trim().toLowerCase();
	if (!value) return state.commands;
	return state.commands.filter((command) => {
		const haystack = `${command.name} ${command.description ?? ""} ${commandSourceLabel(
			command.source,
		)}`.toLowerCase();
		return haystack.includes(value);
	});
}

function openCommandMenu() {
	if (state.commandMenu) {
		closeCommandMenu();
		return;
	}
	closeMenus();
	closeSlash();
	state.commandMenu = { query: "", index: 0, items: [] };
	dom.commandMenu.innerHTML = `<div class="menu-search"><input type="text" placeholder="コマンドを検索" autocomplete="off" spellcheck="false" data-role="command-search" aria-label="コマンドを検索" /></div><div class="command-list" data-role="command-list" role="listbox" aria-label="コマンド"></div>`;
	dom.commandMenu.hidden = false;
	dom.commandButton.setAttribute("aria-expanded", "true");
	renderCommandMenu();
	positionCommandMenu();
	dom.commandMenu.querySelector('[data-role="command-search"]')?.focus();
	refreshCommands();
}

function positionCommandMenu() {
	const popover = dom.commandMenu;
	popover.style.visibility = "hidden";
	popover.hidden = false;
	const anchor = dom.composer.getBoundingClientRect();
	const size = popover.getBoundingClientRect();
	const left = Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8));
	let top = anchor.top - size.height - 8;
	if (top < 8) top = Math.min(anchor.bottom + 8, window.innerHeight - size.height - 8);
	popover.style.left = `${Math.round(left)}px`;
	popover.style.top = `${Math.round(Math.max(8, top))}px`;
	popover.style.visibility = "";
}

function renderCommandMenu() {
	const menu = state.commandMenu;
	if (!menu) return;
	menu.items = filterCommands(menu.query);
	if (menu.index >= menu.items.length) menu.index = Math.max(0, menu.items.length - 1);
	const list = dom.commandMenu.querySelector('[data-role="command-list"]');
	if (!list) return;
	if (!menu.items.length) {
		list.innerHTML = '<div class="menu-empty">見つかりません</div>';
		return;
	}
	list.innerHTML = menu.items
		.map((command, index) => {
			const label = commandSourceLabel(command.source);
			return `<button type="button" class="menu-item command-item${index === menu.index ? " active" : ""}" data-index="${index}" data-testid="command-item" data-source="${escapeHtml(
				label,
			)}" role="option" aria-selected="${index === menu.index}">
				<svg class="icon" aria-hidden="true"><use href="#${commandSourceIcon(command.source)}"/></svg>
				<span class="cmd-name">/${escapeHtml(command.name)}</span>
				<span class="cmd-desc">${escapeHtml(command.description ?? "")}</span>
				<span class="cmd-source">${escapeHtml(label)}</span>
			</button>`;
		})
		.join("");
	list.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
}

function closeCommandMenu() {
	state.commandMenu = null;
	dom.commandMenu.hidden = true;
	dom.commandMenu.replaceChildren();
	dom.commandButton.removeAttribute("aria-expanded");
}

function chooseCommand(command) {
	if (!command) return;
	closeCommandMenu();
	insertCommand(command);
}

async function refreshCommands() {
	try {
		const data = await api({ type: "get_commands" });
		if (!Array.isArray(data?.commands)) return;
		state.commands = data.commands;
		if (state.commandMenu) renderCommandMenu();
		if (state.slash) updateSlash();
	} catch {
		/* keep the last known commands */
	}
}

let commandComposing = false;
let commandCompositionEndedAt = Number.NEGATIVE_INFINITY;

function isCommandIme(event) {
	if (event.isComposing || event.keyCode === 229 || commandComposing) return true;
	return performance.now() - commandCompositionEndedAt < 120;
}

dom.commandButton.addEventListener("click", openCommandMenu);

dom.commandMenu.addEventListener(
	"compositionstart",
	() => {
		commandComposing = true;
	},
	true,
);

dom.commandMenu.addEventListener(
	"compositionend",
	() => {
		commandComposing = false;
		commandCompositionEndedAt = performance.now();
	},
	true,
);

dom.commandMenu.addEventListener("input", (event) => {
	if (!event.target.matches('[data-role="command-search"]') || !state.commandMenu) return;
	state.commandMenu.query = event.target.value;
	state.commandMenu.index = 0;
	renderCommandMenu();
});

dom.commandMenu.addEventListener("keydown", (event) => {
	const menu = state.commandMenu;
	if (!menu) return;
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		closeCommandMenu();
		dom.input.focus();
		return;
	}
	if (event.key === "Enter") {
		if (isCommandIme(event)) return;
		event.preventDefault();
		chooseCommand(menu.items[menu.index]);
		return;
	}
	if (event.key === "Tab") {
		event.preventDefault();
		chooseCommand(menu.items[menu.index]);
		return;
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		if (!menu.items.length) return;
		const delta = event.key === "ArrowDown" ? 1 : -1;
		menu.index = (menu.index + delta + menu.items.length) % menu.items.length;
		renderCommandMenu();
	}
});

dom.commandMenu.addEventListener("click", (event) => {
	const item = event.target.closest("[data-index]");
	if (!item || !state.commandMenu) return;
	chooseCommand(state.commandMenu.items[Number(item.dataset.index)]);
});

dom.slashMenu.addEventListener("click", (event) => {
	const item = event.target.closest("[data-index]");
	if (!item) return;
	const index = Number(item.dataset.index);
	chooseSlash(state.slash?.items[index]);
});

/* ------------------------------------------------------------------ menus */

function openMenu(kind) {
	if (state.menu === kind) {
		closeMenus();
		return;
	}
	closeMenus();
	closeSlash();
	closeCommandMenu();
	state.menu = kind;
	const anchor =
		kind === "model"
			? dom.modelButton
			: kind === "thinking"
				? dom.thinkingButton
				: kind === "settings"
					? dom.settingsButton
					: dom.contextButton;
	const popover =
		kind === "model"
			? dom.modelMenu
			: kind === "thinking"
				? dom.thinkingMenu
				: kind === "settings"
					? dom.settingsMenu
					: dom.contextMenu;

	if (kind === "model") renderModelMenu();
	if (kind === "thinking") renderThinkingMenu();
	if (kind === "settings") renderSettingsMenu();
	if (kind === "context") renderContextMenu();
	anchor.setAttribute("aria-expanded", "true");
	positionPopover(popover, anchor);
	if (kind === "model") dom.modelMenu.querySelector("input")?.focus();
}

function positionPopover(popover, anchor) {
	popover.hidden = false;
	popover.style.visibility = "hidden";
	const rect = anchor.getBoundingClientRect();
	const size = popover.getBoundingClientRect();
	let left = rect.right - size.width;
	left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
	let top = rect.bottom + 8;
	if (top + size.height > window.innerHeight - 12) {
		top = Math.max(8, window.innerHeight - size.height - 12);
	}
	popover.style.left = `${Math.round(left)}px`;
	popover.style.top = `${Math.round(top)}px`;
	popover.style.visibility = "";
}

function closeMenus() {
	dom.modelMenu.hidden = true;
	dom.thinkingMenu.hidden = true;
	dom.settingsMenu.hidden = true;
	dom.contextMenu.hidden = true;
	dom.modelButton.removeAttribute("aria-expanded");
	dom.thinkingButton.removeAttribute("aria-expanded");
	state.menu = null;
}

dom.modelButton.addEventListener("click", () => openMenu("model"));
dom.thinkingButton.addEventListener("click", () => openMenu("thinking"));
dom.settingsButton.addEventListener("click", () => openMenu("settings"));
dom.contextButton.addEventListener("click", () => openMenu("context"));

function renderModelMenu() {
	dom.modelMenu.replaceChildren();
	const search = document.createElement("div");
	search.className = "menu-search";
	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = "モデル";
	input.autocomplete = "off";
	input.addEventListener("input", () => renderModelList(input.value));
	search.append(input);
	const list = document.createElement("div");
	list.dataset.role = "model-list";
	dom.modelMenu.append(search, list);
	renderModelList("");
}

function renderModelList(filter) {
	const list = dom.modelMenu.querySelector('[data-role="model-list"]');
	if (!list) return;
	const query = filter.trim().toLowerCase();
	const models = state.models.filter((model) => {
		if (!query) return true;
		return `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query);
	});
	const groups = new Map();
	for (const model of models) {
		if (!groups.has(model.provider)) groups.set(model.provider, []);
		groups.get(model.provider).push(model);
	}
	if (!models.length) {
		const empty = document.createElement("div");
		empty.className = "menu-empty";
		empty.textContent = "見つかりません";
		list.replaceChildren(empty);
		return;
	}
	const fragments = [];
	for (const [provider, providerModels] of groups) {
		const label = document.createElement("div");
		label.className = "menu-group";
		label.textContent = provider;
		fragments.push(label);
		for (const model of providerModels) {
			const current = state.model?.provider === model.provider && state.model?.id === model.id;
			const item = document.createElement("button");
			item.type = "button";
			item.className = "menu-item";
			item.dataset.provider = model.provider;
			item.dataset.modelId = model.id;
			item.setAttribute("aria-selected", String(current));
			item.dataset.testid = "model-item";
			item.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-model"/></svg><span class="label">${escapeHtml(
				model.name,
			)}</span>${current ? '<svg class="icon check" aria-hidden="true"><use href="#i-check"/></svg>' : ""}`;
			fragments.push(item);
		}
	}
	list.replaceChildren(...fragments);
}

function renderThinkingMenu() {
	const levels = state.levels ?? ["off"];
	dom.thinkingMenu.innerHTML = levels
		.map((level) => {
			const current = level === state.thinkingLevel;
			return `<button type="button" class="menu-item" data-level="${escapeHtml(level)}" aria-selected="${current}" data-testid="thinking-item">
				<span class="label">${escapeHtml(level)}</span>
				${current ? '<svg class="icon check" aria-hidden="true"><use href="#i-check"/></svg>' : ""}
			</button>`;
		})
		.join("");
}

function renderSettingsMenu() {
	const themeOptions = [
		["system", "i-monitor", "システム"],
		["light", "i-sun", "ライト"],
		["dark", "i-moon", "ダーク"],
	]
		.map(
			([value, icon, label]) =>
				`<button type="button" data-theme-option="${value}" aria-pressed="${settings.theme === value}" aria-label="${label}" title="${label}"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></button>`,
		)
		.join("");
	dom.settingsMenu.innerHTML = `<div class="setting-row">
		<span>テーマ</span>
		<div class="segmented" role="group" aria-label="テーマ">${themeOptions}</div>
	</div>
	<div class="setting-row">
		<span>Ctrl+Enter で送信</span>
		<button type="button" class="switch" role="switch" aria-checked="${settings.ctrlEnterSend}" aria-label="Ctrl+Enterで送信" data-testid="ctrl-enter-toggle"></button>
	</div>
	<div class="hint">Enter は改行</div>`;
}

function renderContextMenu() {
	const usage = state.stats?.contextUsage;
	const tokens = usage?.tokens ?? 0;
	const windowSize = usage?.contextWindow ?? state.model?.contextWindow ?? 0;
	const percent = typeof usage?.percent === "number" ? Math.round(usage.percent) : null;
	const cost = typeof state.stats?.cost === "number" ? state.stats.cost : null;
	const rows = [
		["コンテキスト", percent === null ? "—" : `${percent}%`],
		["トークン", windowSize ? `${tokens.toLocaleString()} / ${windowSize.toLocaleString()}` : tokens.toLocaleString()],
		["メッセージ", String(state.stats?.totalMessages ?? state.messages.length)],
	];
	if (cost) rows.push(["コスト", `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`]);
	dom.contextMenu.innerHTML =
		rows
			.map(
				([label, value]) =>
					`<div class="stat-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
			)
			.join("") +
		`<div class="menu-foot"><button type="button" class="menu-item" data-action="compact" data-testid="compact-button"${
			state.running ? " disabled" : ""
		}><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg><span class="label">コンテキストを圧縮</span></button></div>`;
}

dom.modelMenu.addEventListener("click", (event) => {
	const item = event.target.closest("[data-model-id]");
	if (!item) return;
	const model = state.models.find(
		(candidate) => candidate.id === item.dataset.modelId && candidate.provider === item.dataset.provider,
	);
	if (model) setModel(model);
});

dom.thinkingMenu.addEventListener("click", (event) => {
	const item = event.target.closest("[data-level]");
	if (!item) return;
	setThinkingLevel(item.dataset.level);
});

dom.settingsMenu.addEventListener("click", (event) => {
	const themeButton = event.target.closest("[data-theme-option]");
	if (themeButton) {
		const next = themeButton.dataset.themeOption;
		if (!THEMES.includes(next) || settings.theme === next) return;
		settings.theme = next;
		saveSettings();
		applyTheme();
		for (const button of dom.settingsMenu.querySelectorAll("[data-theme-option]")) {
			button.setAttribute("aria-pressed", String(button.dataset.themeOption === next));
		}
		return;
	}
	const toggle = event.target.closest(".switch");
	if (!toggle) return;
	settings.ctrlEnterSend = !settings.ctrlEnterSend;
	saveSettings();
	toggle.setAttribute("aria-checked", String(settings.ctrlEnterSend));
});

dom.contextMenu.addEventListener("click", async (event) => {
	if (!event.target.closest('[data-action="compact"]')) return;
	closeMenus();
	try {
		await api({ type: "compact" });
		await refreshSnapshot();
		toast("コンテキストを圧縮しました");
	} catch (error) {
		toast(error.message, "error");
	}
});

/* ------------------------------------------------------------------ history */

function openHistory() {
	closeMenus();
	closeSlash();
	closeCommandMenu();
	dom.historyPanel.hidden = false;
	dom.drawerBackdrop.hidden = false;
	dom.historyButton.setAttribute("aria-expanded", "true");
	dom.sessionList.innerHTML = '<div class="session-empty">…</div>';
	api({ type: "dock:sessions" })
		.then((sessions) => {
			state.sessions = sessions ?? [];
			renderSessionList();
		})
		.catch((error) => {
			dom.sessionList.innerHTML = `<div class="session-empty">${escapeHtml(error.message)}</div>`;
		});
}

function closeHistory() {
	dom.historyPanel.hidden = true;
	dom.drawerBackdrop.hidden = true;
	dom.historyButton.removeAttribute("aria-expanded");
}

function renderSessionList() {
	if (!state.sessions.length) {
		dom.sessionList.innerHTML = '<div class="session-empty">履歴はありません</div>';
		return;
	}
	const items = state.sessions.map((session, index) => {
		const name = session.name || session.preview || "無題の会話";
		const preview = session.name ? session.preview : "";
		return `<button type="button" class="session-item${session.current ? " current" : ""}" data-index="${index}" data-testid="session-item">
			<span class="s-top"><span class="s-title">${escapeHtml(name)}</span><span class="s-time">${escapeHtml(relativeTime(session.modified))}</span></span>
			${preview ? `<span class="s-preview">${escapeHtml(preview)}</span>` : ""}
		</button>`;
	});
	dom.sessionList.innerHTML = items.join("");
}

function relativeTime(iso) {
	const time = new Date(iso).getTime();
	if (!Number.isFinite(time)) return "";
	const seconds = Math.max(0, (Date.now() - time) / 1000);
	if (seconds < 60) return "たった今";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間前`;
	const date = new Date(time);
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${month}/${day}`;
}

dom.historyButton.addEventListener("click", openHistory);
dom.historyClose.addEventListener("click", closeHistory);
dom.drawerBackdrop.addEventListener("click", closeHistory);
dom.sessionList.addEventListener("click", (event) => {
	const item = event.target.closest("[data-index]");
	if (!item) return;
	const session = state.sessions[Number(item.dataset.index)];
	if (session && !session.current) switchSession(session.path);
});

dom.newChatButton.addEventListener("click", newChat);
dom.jumpButton.addEventListener("click", () => scrollToBottom(true));

/* --------------------------------------------------------------- rendering */

function scheduleMessages() {
	if (messagesFrame) return;
	messagesFrame = requestAnimationFrame(() => {
		messagesFrame = 0;
		renderMessages();
	});
}

function scheduleLive() {
	if (liveFrame) return;
	liveFrame = requestAnimationFrame(() => {
		liveFrame = 0;
		renderLive();
		renderRunStatus();
	});
}

function collectToolResults(messages) {
	const results = new Map();
	const calls = new Set();
	for (const message of messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, message);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.add(block.id);
			}
		}
	}
	return { results, calls };
}

function renderPlan() {
	const plan = state.plan;
	const items = Array.isArray(plan?.items) ? plan.items : [];
	dom.planPanel.hidden = items.length === 0;
	if (!items.length) {
		dom.planCurrent.textContent = "";
		dom.planItems.replaceChildren();
		return;
	}
	dom.planTitle.textContent = plan.title || "計画";
	const current = items.find((item) => item.status === "in_progress");
	dom.planCurrent.textContent = current?.text ?? "";
	const nodes = items.map((item) => {
		const entry = document.createElement("li");
		entry.className = `plan-item ${item.status}`;
		entry.dataset.status = item.status;
		entry.dataset.testid = "plan-item";
		if (item.status === "in_progress") entry.setAttribute("aria-current", "step");
		const box = document.createElement("span");
		box.className = "plan-box";
		box.setAttribute("aria-hidden", "true");
		const text = document.createElement("span");
		text.className = "plan-text";
		text.textContent = item.text;
		entry.append(box, text);
		return entry;
	});
	dom.planItems.replaceChildren(...nodes);
}

function messageRevision(message, ctx) {
	if (message.role === "user") {
		return `u:${textOfContent(message.content).length}:${message.timestamp}:${message._optimistic ? "o" : ""}`;
	}
	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content)
			? message.content
					.map((block) => {
						if (block.type === "text") return `t${block.text.length}`;
						if (block.type === "thinking") return `k${(block.thinking ?? "").length}`;
						if (block.type === "toolCall") {
							const result = ctx.results.get(block.id);
							const resultLength = result ? textOfContent(result.content).length : 0;
							return `c${block.id}:${state.toolRev[block.id] ?? 0}:${resultLength}`;
						}
						return block.type;
					})
					.join("|")
			: "0";
		return `a:${blocks}:${message.stopReason}:${message.errorMessage ?? ""}`;
	}
	if (message.role === "toolResult") {
		return `r:${message.toolCallId}:${textOfContent(message.content).length}:${message.isError}`;
	}
	return `${message.role}:${JSON.stringify(message).length}`;
}

function renderMessages(reset = false) {
	if (reset) {
		dom.messageList.replaceChildren();
		messageNodes.clear();
	}
	const ctx = collectToolResults(state.messages);
	state.messages.forEach((message, index) => {
		const revision = messageRevision(message, ctx);
		const existing = messageNodes.get(index);
		if (existing && existing.revision === revision) return;
		const node = renderMessage(message, index, ctx);
		if (existing) existing.node.replaceWith(node);
		else dom.messageList.append(node);
		messageNodes.set(index, { node, revision });
	});
	for (const [index, entry] of messageNodes) {
		if (index >= state.messages.length) {
			entry.node.remove();
			messageNodes.delete(index);
		}
	}
	dom.empty.hidden = state.messages.length > 0 || Boolean(state.live) || state.running;
	if (stickToBottom) scrollToBottom();
}

function renderMessage(message, index, ctx) {
	if (message.role === "user") return renderUser(message);
	if (message.role === "assistant") return renderAssistant(message, index, ctx, false);
	if (message.role === "toolResult") {
		if (ctx.calls.has(message.toolCallId) || message.toolName === "dock_plan") {
			const skip = document.createElement("div");
			skip.hidden = true;
			return skip;
		}
		return renderToolResult(message, index);
	}
	if (message.role === "bashExecution") {
		return renderToolCard(
			{
				id: `bash-${index}`,
				name: "bash",
				arguments: { command: message.command },
				output: message.output,
				status: message.cancelled ? "error" : "done",
				durationMs: undefined,
			},
			`m${index}`,
		);
	}
	if (message.role === "compactionSummary") {
		return renderSummaryNote(message.summary, "圧縮", index);
	}
	if (message.role === "branchSummary") {
		return renderSummaryNote(message.summary, "分岐", index);
	}
	if (message.role === "custom") {
		const note = document.createElement("div");
		note.className = "note";
		note.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-extension"/></svg>';
		const span = document.createElement("span");
		span.textContent = textOfContent(message.content) || message.customType || "";
		note.append(span);
		return note;
	}
	const hidden = document.createElement("div");
	hidden.hidden = true;
	return hidden;
}

function renderUser(message) {
	const node = document.createElement("div");
	node.className = "user";
	node.dataset.testid = "message-user";
	const content = message.content;
	if (Array.isArray(content) && content.some((block) => block?.type === "image")) {
		const text = textOfContent(content);
		const textNode = document.createElement("div");
		textNode.textContent = text;
		node.append(textNode);
		for (const block of content) {
			if (block?.type !== "image") continue;
			const image = document.createElement("img");
			image.alt = "";
			image.src = `data:${block.mimeType};base64,${block.data}`;
			node.append(image);
		}
	} else {
		node.textContent = textOfContent(content);
	}
	return node;
}

function renderAssistant(message, index, ctx, live) {
	const node = document.createElement("div");
	node.className = `assistant${live ? " live" : ""}`;
	node.dataset.testid = live ? "message-live" : "message-assistant";
	const blocks = Array.isArray(message.content) ? message.content : [];
	node.innerHTML = renderBlocks(blocks, `m${index}`, ctx);
	if (message.stopReason === "aborted") {
		node.append(note("中断されました"));
	} else if (message.stopReason === "error") {
		node.append(note(message.errorMessage || "エラーが発生しました", true));
	} else if (message.stopReason === "length") {
		node.append(note("出力が上限に達しました"));
	}
	return node;
}

function note(text, error = false) {
	const element = document.createElement("div");
	element.className = "note";
	element.style.color = error ? "var(--err)" : "";
	element.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${error ? "i-alert" : "i-spark"}"/></svg>`;
	const span = document.createElement("span");
	span.textContent = text;
	element.append(span);
	return element;
}

function renderSummaryNote(summary, label, index) {
	const key = `summary-${index}`;
	const wrap = document.createElement("details");
	wrap.className = "thinking";
	wrap.dataset.key = key;
	if (openKeys.has(key)) wrap.open = true;
	wrap.innerHTML = `<summary><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg><span>${escapeHtml(
		label,
	)}</span><svg class="icon chev" aria-hidden="true"><use href="#i-chevron"/></svg></summary><div class="thinking-text">${escapeHtml(
		summary ?? "",
	)}</div>`;
	return wrap;
}

function renderBlocks(blocks, prefix, ctx) {
	const parts = [];
	blocks.forEach((block, index) => {
		if (!block) return;
		if (block.type === "text") {
			if (!block.text) return;
			parts.push(`<div class="md">${renderMarkdown(block.text)}</div>`);
			return;
		}
		if (block.type === "thinking") {
			if (!block.thinking) return;
			const key = `${prefix}:t${index}`;
			parts.push(
				`<details class="thinking" data-key="${key}"${openKeys.has(key) ? " open" : ""} data-testid="thinking">
					<summary><svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg><span>思考</span><svg class="icon chev" aria-hidden="true"><use href="#i-chevron"/></svg></summary>
					<div class="thinking-text">${escapeHtml(block.thinking)}</div>
				</details>`,
			);
			return;
		}
		if (block.type === "toolCall") {
			if (block.name === "dock_plan" || state.tools[block.id]?.name === "dock_plan") return;
			const result = ctx.results.get(block.id);
			const tool = state.tools[block.id];
			const args = tool?.args ?? block.arguments ?? parseArgs(block.partialArgs);
			const output = tool?.output || (result ? textOfContent(result.content) : "");
			let status = tool?.status;
			if (!status) {
				if (result) status = result.isError ? "error" : "done";
				else status = state.running ? "running" : "done";
			}
			parts.push(
				toolCardMarkup(
					{
						id: block.id,
						name: block.name ?? tool?.name,
						arguments: args,
						output,
						status,
						durationMs: tool?.durationMs,
					},
					prefix,
					"tool",
				),
			);
		}
	});
	return parts.join("");
}

function parseArgs(text) {
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { arguments: text };
	}
}

function toolSummary(name, args) {
	if (!args) return "";
	if (typeof args === "string") return args.slice(0, 160);
	if (typeof args !== "object") return "";
	const pick =
		args.command ??
		args.path ??
		args.file_path ??
		args.pattern ??
		args.query ??
		args.url ??
		args.description ??
		args.task;
	if (typeof pick === "string") return pick;
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

function formatDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	if (ms < 950) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function toolCardMarkup(tool, prefix, testId = "tool") {
	const key = `${prefix}:c:${tool.id}`;
	const summary = toolSummary(tool.name, tool.arguments).replace(/\s+/g, " ").slice(0, 200);
	const output = (tool.output ?? "").replace(/\s+$/, "");
	const clipped = output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}
…` : output;
	const status = tool.status ?? "done";
	const meta = formatDuration(tool.durationMs);
	return `<details class="tool${status === "error" ? " error" : ""}" data-key="${escapeHtml(key)}"${
		openKeys.has(key) ? " open" : ""
	} data-testid="${testId}">
		<summary>
			<span class="dot ${status}"></span>
			<svg class="icon" aria-hidden="true"><use href="#i-tool"/></svg>
			<span class="tool-name">${escapeHtml(tool.name ?? "tool")}</span>
			<span class="tool-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
			${meta ? `<span class="tool-meta">${escapeHtml(meta)}</span>` : ""}
			<svg class="icon chev" aria-hidden="true"><use href="#i-chevron"/></svg>
		</summary>
		<div class="tool-body">${
			clipped ? `<pre>${escapeHtml(clipped)}</pre>` : '<div class="note">出力なし</div>'
		}</div>
	</details>`;
}

function renderToolCard(tool, prefix, testId = "tool") {
	const holder = document.createElement("div");
	holder.innerHTML = toolCardMarkup(tool, prefix, testId);
	return holder.firstElementChild;
}

function renderToolResult(message, index) {
	const tool = {
		id: `result-${index}`,
		name: message.toolName ?? "tool",
		arguments: {},
		output: textOfContent(message.content),
		status: message.isError ? "error" : "done",
	};
	return renderToolCard(tool, `m${index}`, "tool-result");
}

function renderLive() {
	const blocks = state.live?.blocks?.filter(Boolean) ?? [];
	if (!blocks.length) {
		if (dom.liveMount.childElementCount) dom.liveMount.replaceChildren();
		dom.empty.hidden = state.messages.length > 0 || state.running;
		return;
	}
	const ctx = collectToolResults(state.messages);
	const node = document.createElement("div");
	node.className = "assistant live";
	node.dataset.testid = "message-live";
	node.innerHTML = renderBlocks(blocks, "live", ctx);
	dom.liveMount.replaceChildren(node);
	dom.empty.hidden = true;
	if (stickToBottom) scrollToBottom();
}

function renderRunStatus() {
	const active = state.running || state.aborting || state.compacting || Boolean(state.retry);
	dom.runStatus.hidden = !active;
	if (!active) {
		dom.runStatus.replaceChildren();
		return;
	}
	const text = state.compacting
		? "コンテキストを圧縮中"
		: state.retry
			? `再試行 ${state.retry.attempt}/${state.retry.maxAttempts}`
			: "";
	dom.runStatus.innerHTML = `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>${
		text ? `<span>${escapeHtml(text)}</span>` : ""
	}`;
}

function renderChrome() {
	const project = state.cwd ? state.cwd.split(/[\\/]/).filter(Boolean).pop() : "";
	dom.projectName.textContent = project || "pi-dock";
	dom.projectName.title = state.cwd;
	dom.sessionName.textContent = state.sessionName;
	dom.sessionName.title = state.sessionName;
	dom.modelLabel.textContent = state.model?.name ?? "モデル";
	dom.modelButton.title = state.model ? `${state.model.provider}/${state.model.id}` : "モデル";
	dom.thinkingLabel.textContent = state.thinkingLevel;
	dom.thinkingButton.title = `思考レベル: ${state.thinkingLevel}`;

	const usage = state.stats?.contextUsage;
	const percent = typeof usage?.percent === "number" ? Math.max(0, Math.min(100, usage.percent)) : 0;
	const circumference = 47.12;
	dom.ringFg.setAttribute("stroke-dashoffset", String(circumference * (1 - percent / 100)));
	dom.contextButton.classList.toggle("warn", percent >= 80 && percent < 95);
	dom.contextButton.classList.toggle("danger", percent >= 95);
	dom.contextButton.title = usage
		? `コンテキスト ${Math.round(percent)}% (${(usage.tokens ?? 0).toLocaleString()} / ${(usage.contextWindow ?? 0).toLocaleString()})`
		: "コンテキスト";

	updateSendButton();
	renderSendMode();
	const queued = state.queue.steering.length + state.queue.followUp.length;
	dom.queueBadge.hidden = queued === 0;
	dom.queueBadge.textContent = `${queued} 待機`;

	const statuses = Object.values(state.statuses).filter(Boolean);
	dom.composerLeft.replaceChildren(
		...statuses.slice(0, 3).map((text) => {
			const chip = document.createElement("span");
			chip.className = "meta-chip";
			chip.textContent = text;
			chip.title = text;
			return chip;
		}),
	);

	renderWidgets();
	renderBanner();
	document.title = state.sessionName ? `${state.sessionName} · pi-dock` : "pi-dock";
}

function renderWidgets() {
	const lines = Object.values(state.widgets);
	dom.widgets.hidden = lines.length === 0;
	dom.widgets.textContent = lines.join("\n");
}

function renderBanner() {
	if (state.piDown) {
		showBanner(state.piDown, { label: "再起動", action: restartPi });
	} else if (!state.ready) {
		showBanner("Pi に接続しています…", null);
	} else if (!state.connected) {
		showBanner("サーバーに再接続しています…", null);
	} else {
		dom.banner.hidden = true;
	}
}

function showBanner(text, action) {
	dom.banner.hidden = false;
	dom.bannerText.textContent = text;
	dom.bannerAction.hidden = !action;
	if (action) {
		dom.bannerAction.textContent = action.label;
		dom.bannerAction.onclick = action.action;
	}
}

async function restartPi() {
	dom.banner.hidden = true;
	try {
		await api({ type: "dock:restart" });
		await refreshSnapshot();
	} catch (error) {
		state.piDown = error.message;
		renderBanner();
	}
}

/* ------------------------------------------------------------------ scroll */

function distanceFromBottom() {
	return dom.scroller.scrollHeight - dom.scroller.scrollTop - dom.scroller.clientHeight;
}

dom.scroller.addEventListener(
	"scroll",
	() => {
		stickToBottom = distanceFromBottom() < 90;
		dom.jumpButton.hidden = stickToBottom || !state.messages.length;
	},
	{ passive: true },
);

function scrollToBottom(force = false) {
	if (force) stickToBottom = true;
	if (!stickToBottom) {
		dom.jumpButton.hidden = false;
		return;
	}
	requestAnimationFrame(() => {
		dom.scroller.scrollTop = dom.scroller.scrollHeight;
		dom.jumpButton.hidden = true;
	});
}

/* ------------------------------------------------------------------- misc */

function toast(message, kind = "info", duration = 3600) {
	if (!message) return;
	const node = document.createElement("div");
	node.className = `toast ${kind}`;
	node.dataset.testid = "toast";
	node.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${kind === "error" ? "i-alert" : "i-spark"}"/></svg>`;
	const span = document.createElement("span");
	span.textContent = message;
	node.append(span);
	dom.toasts.append(node);
	setTimeout(() => node.remove(), duration);
}

async function copyText(text, trigger) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
	if (!trigger) return;
	trigger.classList.add("copied");
	const use = trigger.querySelector("use");
	if (use) {
		use.setAttribute("href", "#i-check");
		setTimeout(() => {
			use.setAttribute("href", "#i-copy");
			trigger.classList.remove("copied");
		}, 1400);
	}
}

function onTranscriptClick(event) {
	const copy = event.target.closest(".code-copy");
	if (copy) {
		const block = copy.closest(".code-block");
		const code = block?.querySelector("code");
		if (code) copyText(code.textContent ?? "", copy);
	}
}

dom.messageList.addEventListener("click", onTranscriptClick);
dom.liveMount.addEventListener("click", onTranscriptClick);

for (const container of [dom.messageList, dom.liveMount]) {
	container.addEventListener(
		"toggle",
		(event) => {
			const details = event.target;
			if (!(details instanceof HTMLDetailsElement) || !details.dataset.key) return;
			if (details.open) openKeys.add(details.dataset.key);
			else openKeys.delete(details.dataset.key);
		},
		true,
	);
}

/* ------------------------------------------------------------------- boot */

async function boot() {
	applyTheme();
	renderChrome();
	renderLive();
	renderPlan();
	renderRunStatus();
	autosize();
	if (!TOKEN) {
		showBanner("URL にトークンがありません。起動時に表示された URL を開いてください。", null);
		return;
	}

	document.addEventListener("keydown", (event) => {
		if (event.key !== "/" || state.dialogs.length) return;
		const target = event.target;
		const typing =
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target?.isContentEditable;
		if (typing) return;
		event.preventDefault();
		dom.input.focus();
	});

	connect();
	try {
		await refreshSnapshot();
	} catch (error) {
		state.ready = false;
		showBanner(`Pi に接続できません: ${error.message}`, { label: "再試行", action: () => bootRefresh() });
	}
	dom.input.focus();
}

async function bootRefresh() {
	try {
		await api({ type: "dock:restart" }).catch(() => {});
		await refreshSnapshot();
	} catch (error) {
		showBanner(`Pi に接続できません: ${error.message}`, { label: "再試行", action: () => bootRefresh() });
	}
}

boot();
