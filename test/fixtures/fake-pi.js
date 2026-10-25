#!/usr/bin/env node
// E2E fixture that speaks the Pi RPC protocol. It never touches the network or
// the user's Pi configuration; the E2E tests drive this instead of a real model.
import { readFile } from "node:fs/promises";

/** @typedef {import("../../src/pi-types.js").PiRecord} PiRecord */
/** @typedef {import("../../src/pi-types.js").PiResponse} PiResponse */
/** @typedef {import("../../src/pi-types.js").PiAssistantMessage} PiAssistantMessage */
/** @typedef {import("../../src/pi-types.js").PiUserMessage} PiUserMessage */
/** @typedef {import("../../src/pi-types.js").PiContentBlock} PiContentBlock */
/** @typedef {import("../../src/pi-types.js").PiToolOutput} PiToolOutput */
/** @typedef {import("../../src/pi-types.js").PiToolResultMessage} PiToolResultMessage */

const MODELS = [
	{
		id: "fake-fast",
		name: "Fake Fast",
		provider: "fake",
		api: "fake-api",
		reasoning: false,
		contextWindow: 1_000_000,
	},
	{
		id: "fake-reason",
		name: "Fake Reasoner",
		provider: "fake",
		api: "fake-api",
		reasoning: true,
		contextWindow: 128_000,
	},
];

const COMMANDS = [
	{
		name: "fix-tests",
		description: "Fix failing tests",
		source: "prompt",
		sourceInfo: { path: "/tmp/fix-tests.md", source: "local", scope: "project", origin: "top-level" },
	},
	{
		name: "skill:review",
		description: "Review the current diff",
		source: "skill",
		sourceInfo: { path: "/tmp/review", source: "local", scope: "user", origin: "top-level" },
	},
	{
		name: "deploy",
		description: "Deploy the project",
		source: "extension",
		sourceInfo: { path: "/tmp/deploy.ts", source: "local", scope: "project", origin: "top-level" },
	},
];

const SCREENSHOT_MODE = process.env.FAKE_PI_SCREENSHOT === "1";
if (SCREENSHOT_MODE) {
	MODELS.push({
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		provider: "opencode-go",
		api: "openai-completions",
		reasoning: true,
		contextWindow: 1_000_000,
	});
}
let screenshotTurn = 0;

const SLOW = process.env.FAKE_PI_SPEED === "slow" ? 60 : 12;

const session = {
	messages: [],
	entries: [],
	leafId: null,
	nextEntry: 1,
	plan: null,
	model: MODELS[0],
	thinkingLevel: "off",
	sessionId: "fake-session",
	sessionFile: process.env.FAKE_PI_SESSION ?? undefined,
	sessionName: undefined,
	running: false,
	aborted: false,
	uiWaiters: new Map(),
	steering: [],
	followUp: [],
	sequence: 0,
	contextTokens: 1234,
	contextUnknown: false,
	cost: 0.001,
};

const envModel = process.env.FAKE_PI_MODEL;
if (envModel) {
	session.model =
		MODELS.find(
			(model) => model.id === envModel || `${model.provider}/${model.id}` === envModel,
		) ?? session.model;
}
if (process.env.FAKE_PI_THINKING) session.thinkingLevel = process.env.FAKE_PI_THINKING;
const envContextTokens = Number(process.env.FAKE_PI_CONTEXT_TOKENS);
if (Number.isFinite(envContextTokens) && envContextTokens > 0) {
	session.contextTokens = envContextTokens;
}
const envCost = Number(process.env.FAKE_PI_COST);
if (Number.isFinite(envCost) && envCost >= 0) session.cost = envCost;
if (process.env.FAKE_PI_SESSION_NAME) session.sessionName = process.env.FAKE_PI_SESSION_NAME;

let buffer = "";

async function openSession(path) {
	const text = await readFile(path, "utf8");
	const entries = text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	const header = entries.find((entry) => entry.type === "session");
	const info = entries.filter((entry) => entry.type === "session_info").at(-1);
	session.sessionId = header?.id ?? "imported";
	session.sessionFile = path;
	session.sessionName = info?.name;
	session.entries = entries.filter(
		(entry) => entry.type !== "session" && typeof entry.id === "string",
	);
	session.leafId = session.entries.at(-1)?.id ?? null;
	const planEntry = entries
		.filter((entry) => entry.type === "custom" && entry.customType === "tiny_plan_state")
		.at(-1);
	session.plan = planEntry?.data ?? null;
	session.messages = entries
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
}

const sessionArg = process.argv.indexOf("--session");
if (sessionArg !== -1 && process.argv[sessionArg + 1]) {
	try {
		await openSession(process.argv[sessionArg + 1]);
	} catch {
		/* start an empty session if the fixture file is missing */
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		handle(record);
	}
});

/** @param {PiRecord | PiResponse} record */
function write(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * @param {string} id
 * @param {string} command
 * @param {unknown} [data]
 * @param {string} [error]
 */
function respond(id, command, data, error) {
	if (error === undefined) {
		write(/** @type {PiResponse} */ ({ id, type: "response", command, success: true, data }));
	} else {
		write(/** @type {PiResponse} */ ({ id, type: "response", command, success: false, error }));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns {import("../../src/pi-types.js").PiUsage} */
function usage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * @param {PiAssistantMessage["content"]} content
 * @param {PiAssistantMessage["stopReason"]} [stopReason]
 * @returns {PiAssistantMessage}
 */
function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "fake-api",
		provider: session.model.provider,
		model: session.model.id,
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * @param {string} content
 * @param {import("../../src/pi-types.js").PiImageBlock[]} [images]
 * @returns {PiUserMessage}
 */
function user(content, images = []) {
	return {
		role: "user",
		content: images.length ? [{ type: "text", text: content }, ...images] : content,
		timestamp: Date.now(),
	};
}

function pushEntry(entry) {
	const id = `e${Date.now().toString(36)}${(session.nextEntry++).toString(36)}`;
	const stored = {
		...entry,
		id,
		parentId: session.leafId,
		timestamp: new Date().toISOString(),
	};
	session.entries.push(stored);
	session.leafId = id;
	return stored;
}

function pushMessage(message) {
	pushEntry({ type: "message", message });
	session.messages.push(message);
}

function pushPlanEntry(plan) {
	const entry = pushEntry({
		type: "custom",
		customType: "tiny_plan_state",
		data: { ...plan, items: plan.items.map((item) => ({ ...item })) },
	});
	write({ type: "entry_appended", entry });
}

function formatPlan(plan) {
	const marks = { done: "[x]", in_progress: "[>]", pending: "[ ]", cancelled: "[-]" };
	const lines = plan.title ? [plan.title] : [];
	for (const item of plan.items) lines.push(`${marks[item.status]} ${item.id}: ${item.text}`);
	return lines.length ? lines.join("\n") : "No plan";
}

function normalizeNote(value) {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * @param {any} args
 * @returns {PiToolOutput}
 */
function applyPlan(args) {
	const existing = new Map((session.plan?.items ?? []).map((item) => [item.id, item]));
	let items = (session.plan?.items ?? []).map((item) => ({ ...item }));
	let nextId = session.plan?.nextId ?? 1;
	let title = session.plan?.title;
	let note = session.plan?.note;
	if (args.action === "set") {
		items = [];
		for (const raw of args.items ?? []) {
			const current = raw.id ? existing.get(raw.id) : undefined;
			const text = raw.text ?? current?.text;
			const id = current ? current.id : `p${nextId++}`;
			items.push({ id, text, status: raw.status ?? current?.status ?? "pending" });
		}
		title = args.title;
		note = normalizeNote(args.note) || undefined;
	} else if (args.action === "add") {
		items.push({ id: `p${nextId++}`, text: args.text, status: args.status ?? "pending" });
		if (args.note !== undefined) note = normalizeNote(args.note) || undefined;
	} else if (args.action === "update") {
		const item = items.find((candidate) => candidate.id === args.id);
		if (item) {
			if (args.text) item.text = args.text;
			if (args.status) item.status = args.status;
		}
		if (args.note !== undefined) note = normalizeNote(args.note) || undefined;
	} else if (args.action === "remove") {
		items = items.filter((item) => item.id !== args.id);
	} else if (args.action === "clear") {
		items = [];
		nextId = 1;
		title = undefined;
		note = undefined;
	} else if (args.action === "note") {
		note = normalizeNote(args.note) || undefined;
	}
	session.plan = { ...(title ? { title } : {}), ...(note ? { note } : {}), items, nextId };
	pushPlanEntry(session.plan);
	return {
		content: [{ type: "text", text: formatPlan(session.plan) }],
		details: { ...session.plan, action: args.action },
	};
}

async function streamAssistant(parts, { slow = false } = {}) {
	const delay = slow ? Math.max(SLOW, 28) : SLOW;
	const calls = [];
	const started = Date.now();
	write({ type: "message_start", message: assistant([], "pending") });
	/** @type {PiAssistantMessage["content"]} */
	const content = [];
	for (const [index, part] of parts.entries()) {
		if (part.type === "thinking") {
			write({ type: "message_update", usage: usage(), assistantMessageEvent: { type: "thinking_start", contentIndex: index } });
			for (const delta of chunk(part.text)) {
				if (session.aborted) break;
				session.contextTokens += 3;
				write({
					type: "message_update",
				usage: usage(),
					assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta },
				});
				await sleep(delay);
			}
			write({
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: { type: "thinking_end", contentIndex: index, content: part.text },
			});
			content[index] = { type: "thinking", thinking: part.text };
		} else if (part.type === "text") {
			write({ type: "message_update", usage: usage(), assistantMessageEvent: { type: "text_start", contentIndex: index } });
			for (const delta of chunk(part.text)) {
				if (session.aborted) break;
				session.contextTokens += 5;
				write({
					type: "message_update",
				usage: usage(),
					assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
				});
				await sleep(delay);
			}
			write({
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: { type: "text_end", contentIndex: index, content: part.text },
			});
			content[index] = { type: "text", text: part.text };
		} else if (part.type === "toolCall") {
			const id = `call_${++session.sequence}`;
			session.lastToolCall = { id, name: part.name, arguments: part.args };
			calls.push(session.lastToolCall);
			write({
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id, toolName: part.name },
			});
			const json = JSON.stringify(part.args);
			for (const delta of chunk(json, 6)) {
				if (session.aborted) break;
				write({
					type: "message_update",
				usage: usage(),
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta },
				});
				await sleep(4);
			}
			write({
				type: "message_update",
				usage: usage(),
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: index,
					toolCall: { type: "toolCall", id, name: part.name, arguments: part.args },
				},
			});
			content[index] = { type: "toolCall", id, name: part.name, arguments: part.args };
		}
		if (session.aborted) break;
	}
	const final = assistant(content, session.aborted ? "aborted" : "stop");
	write({ type: "message_end", message: final });
	pushMessage(final);
	write({ type: "turn_end", message: final, toolResults: [] });
	session.contextUnknown = false;
	return { durationMs: Date.now() - started, calls };
}

/**
 * @param {any} [call]
 * @param {{ isError?: boolean, output?: string }} [options]
 */
async function runTool(call = session.lastToolCall, { isError = false, output } = {}) {
	if (!call) return;
	write({
		type: "tool_execution_start",
		toolCallId: call.id,
		toolName: call.name,
		args: call.arguments,
	});
	await sleep(20);
	write({
		type: "tool_execution_update",
		toolCallId: call.id,
		toolName: call.name,
		args: call.arguments,
		partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
	});
	await sleep(20);
	const outcome = /** @type {PiToolOutput} */ (
		call.name === "tiny_plan"
			? applyPlan(call.arguments)
			: call.name === "edit"
				? {
						content: [{ type: "text", text: `Successfully edited ${call.arguments.path}\n` }],
						details: {
							patch:
								call.arguments?.patch ??
								`--- ${call.arguments.path}
+++ ${call.arguments.path}
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
`,
						},
					}
				: {
						content: [
							{
								type: "text",
								text: output ?? (isError ? "boom from fake pi\n" : "hi from fake pi\n"),
							},
						],
						details: {},
					}
	);
	session.contextTokens += 700;
	write({
		type: "tool_execution_end",
		toolCallId: call.id,
		toolName: call.name,
		result: outcome,
		isError,
		durationMs: 41,
	});
	/** @type {PiToolResultMessage} */
	const result = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: outcome.content,
		details: outcome.details,
		isError,
		timestamp: Date.now(),
	};
	write({ type: "message_start", message: { ...result, content: [] } });
	write({ type: "message_end", message: result });
	pushMessage(result);
}

function chunk(text, size = 5) {
	const chunks = [];
	for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
	return chunks.length ? chunks : [""];
}

async function planPrompt(message) {
	const current = session.plan;
	let args;
	if (message.includes("note")) {
		await streamAssistant([
			{
				type: "toolCall",
				name: "tiny_plan",
				args: {
					action: "set",
					title: "実装計画",
					note: "まずRPCとUIの現状を確認します。",
					items: [
						{ text: "RPCの確認", status: "done" },
						{ text: "UIの実装", status: "done" },
						{ text: "既存機能との統合", status: "in_progress" },
						{ text: "E2Eテスト", status: "pending" },
						{ text: "最終検証", status: "pending" },
					],
				},
			},
		]);
		await runTool();
		await sleep(2000);
		await streamAssistant([
			{
				type: "toolCall",
				name: "tiny_plan",
				args: {
					action: "note",
					note: "復元分岐を修正中。次にテストを追加します。",
				},
			},
		]);
		await runTool();
		await sleep(300);
		await streamAssistant(
			[{ type: "text", text: "進捗メモを更新しました。".repeat(80) }],
			{ slow: true },
		);
		return;
	}
	if (message.includes("clear")) {
		args = { action: "clear" };
	} else if (message.includes("advance")) {
		const items = (current?.items ?? []).map((item) => ({ ...item }));
		const active = items.find((item) => item.status === "in_progress");
		if (active) active.status = "done";
		const next = items.find((item) => item.status === "pending");
		if (next) next.status = "in_progress";
		args = { action: "set", title: current?.title ?? "実装計画", items };
	} else if (message.includes("cancel")) {
		const items = (current?.items ?? []).map((item) => ({ ...item }));
		const target = items.filter((item) => item.status === "pending").at(-1);
		if (target) target.status = "cancelled";
		args = { action: "set", title: current?.title ?? "実装計画", items };
	} else if (message.includes("continue")) {
		args = { action: "add", text: "追加の確認", status: "pending" };
	} else if (message.includes("english")) {
		args = {
			action: "set",
			title: "Implementation plan",
			items: [
				{ text: "Inspect the RPC protocol", status: "done" },
				{ text: "Build the Plan panel", status: "done" },
				{ text: "Integrate with existing features", status: "in_progress" },
				{ text: "Add E2E coverage", status: "pending" },
				{ text: "Final verification", status: "pending" },
			],
		};
	} else {
		args = {
			action: "set",
			title: "実装計画",
			items: [
				{ text: "RPCの確認", status: "done" },
				{ text: "UIの実装", status: "done" },
				{ text: "既存機能との統合", status: "in_progress" },
				{ text: "E2Eテスト", status: "pending" },
				{ text: "最終検証", status: "pending" },
			],
		};
	}
	await streamAssistant([{ type: "toolCall", name: "tiny_plan", args }]);
	await runTool();
	await sleep(message.includes("slow") ? 900 : 150);
	await streamAssistant([{ type: "text", text: `plan action: ${args.action}` }]);
}

const SCREENSHOT_PLAN = [
	{ text: "Inspect the context menu and settings flow", status: "done" },
	{ text: "Add the 25% preset and Pi default fallback", status: "done" },
	{ text: "Verify the threshold against the live context meter", status: "in_progress" },
	{ text: "Check WSL path normalization", status: "pending" },
	{ text: "Update README and screenshot", status: "pending" },
	{ text: "Run the full E2E suite", status: "pending" },
	{ text: "Remove the old ad-hoc threshold code", status: "cancelled" },
];

function screenshotPlanWith(statuses) {
	return {
		action: "set",
		title: "Compaction preset rollout",
		items: SCREENSHOT_PLAN.map((item, index) => ({
			text: item.text,
			status: statuses[index] ?? item.status,
		})),
	};
}

function demoPatch(path, added, removed) {
	const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${removed + 4} +1,${added + 4} @@`];
	const oldCode = [
		"const threshold = Math.round(contextWindow * 0.5);",
		"if (settings.compaction?.enabled === false) return;",
		"const preset = settings.compaction?.reserveTokens;",
		"renderContextMenu();",
	];
	const newCode = [
		"const preset = state.compaction?.thresholdPercent;",
		"const enabled = state.compaction?.enabled !== false;",
		"if (!enabled || !Number.isFinite(preset)) return;",
		"renderCompactionMeter(used, limit);",
	];
	for (let index = 0; index < removed; index += 1) {
		lines.push(`-${oldCode[index % oldCode.length]}`);
	}
	for (let index = 0; index < added; index += 1) {
		lines.push(`+${newCode[index % newCode.length]}`);
	}
	return `${lines.join("\n")}\n`;
}

async function screenshotPrompt(turn) {
	if (turn === 1) {
		applyPlan(
			screenshotPlanWith([
				"done",
				"in_progress",
				"pending",
				"pending",
				"pending",
				"pending",
				"cancelled",
			]),
		);
		const { calls } = await streamAssistant([
			{
				type: "thinking",
				text: "The preset can reuse the existing threshold writer, so I'll keep the UI and settings code untouched apart from the new option.",
			},
			{ type: "text", text: "Adding the 25% preset next to the existing thresholds now." },
			{ type: "toolCall", name: "read", args: { path: "public/app.js", limit: 180 } },
			{
				type: "toolCall",
				name: "edit",
				args: { path: "public/app.js", patch: demoPatch("public/app.js", 54, 13) },
			},
			{ type: "toolCall", name: "bash", args: { command: "npm run typecheck" } },
		]);
		await runTool(calls[0], { output: "Read public/app.js (420 lines)\n" });
		await runTool(calls[1]);
		await runTool(calls[2], {
			output: "tsc -p tsconfig.json\ntsc -p tsconfig.extension.json\n",
		});
		await streamAssistant([
			{
				type: "text",
				text: "The context panel now has a 25% preset next to 50%, 75%, and Pi default. The selected preset is read back from Pi's settings, so it survives restarts and stays in sync with the terminal.",
			},
		]);
		return;
	}

	if (turn === 2) {
		applyPlan(
			screenshotPlanWith([
				"done",
				"done",
				"in_progress",
				"pending",
				"pending",
				"pending",
				"cancelled",
			]),
		);
		const first = await streamAssistant([
			{
				type: "thinking",
				text: "The focused spec should catch the new preset, so I'll run it before touching the assertion.",
			},
			{ type: "text", text: "Running the focused context menu test." },
			{
				type: "toolCall",
				name: "bash",
				args: { command: "npx playwright test test/e2e/tinychat.spec.js -g compaction" },
			},
		]);
		await runTool(first.calls[0], {
			isError: true,
			output: "1 failed\nExpected: pressed=true\nReceived: pressed=false\n",
		});
		const second = await streamAssistant([
			{
				type: "thinking",
				text: "The preset is saved, but the test asserts before the settings response arrives.",
			},
			{
				type: "text",
				text: "The menu rendered before the settings round-trip, so I'll make the assertion wait for the response.",
			},
			{
				type: "toolCall",
				name: "edit",
				args: {
					path: "test/e2e/tinychat.spec.js",
					patch: demoPatch("test/e2e/tinychat.spec.js", 12, 3),
				},
			},
		]);
		await runTool(second.calls[0]);
		await streamAssistant([
			{
				type: "text",
				text: "The focused spec is green. The 25% preset stays pressed on slower machines because the menu now waits for the settings response.",
			},
		]);
		return;
	}

	applyPlan(
		screenshotPlanWith([
			"done",
			"done",
			"done",
			"done",
			"in_progress",
			"pending",
			"cancelled",
		]),
	);
	const first = await streamAssistant([
		{
			type: "thinking",
			text: "WSL uses the same POSIX separator, but the session directory still normalizes both slash styles. I'll check the helper before starting the cross-platform run.",
		},
		{
			type: "text",
			text: "Both separators should normalize to the same session directory. I'll verify the helper and then run the Pi integration suite.",
		},
		{ type: "toolCall", name: "read", args: { path: "src/sessions.js", limit: 80 } },
		{
			type: "toolCall",
			name: "edit",
			args: { path: "src/sessions.js", patch: demoPatch("src/sessions.js", 96, 21) },
		},
	]);
	await runTool(first.calls[0], { output: "Read src/sessions.js (280 lines)\n" });
	await runTool(first.calls[1]);
	const second = await streamAssistant([
		{
			type: "thinking",
			text: "The path helper is consistent. I'll run the Pi integration suite and then finish the README.",
		},
		{
			type: "text",
			text: "Path normalization is consistent for both separators. The Pi integration suite is running now; the README update is the only remaining step.",
		},
		{ type: "toolCall", name: "bash", args: { command: "npm run test:pi" } },
	]);
	const call = second.calls[0];
	write({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
	await sleep(80);
	write({
		type: "tool_execution_update",
		toolCallId: call.id,
		toolName: call.name,
		args: call.arguments,
		partialResult: {
			content: [{ type: "text", text: "starting real Pi integration...\n" }],
			details: {},
		},
	});
	await new Promise(() => {});
}

async function prompt(message, images = []) {
	session.running = true;
	session.aborted = false;
	write({ type: "agent_start" });
	try {
		await promptInner(message, images);
		await flushQueue();
	} finally {
		const aborted = session.aborted;
		session.running = false;
		session.contextUnknown = false;
		write({ type: "agent_end", messages: [], willRetry: false });
		write({ type: "agent_settled", aborted });
		session.aborted = false;
	}
}

async function flushQueue() {
	if (session.aborted) return;
	const queued = [...session.steering, ...session.followUp];
	if (!queued.length) return;
	session.steering = [];
	session.followUp = [];
	write({ type: "queue_update", steering: [], followUp: [] });
	for (const text of queued) {
		const message = user(text);
		write({ type: "message_start", message });
		write({ type: "message_end", message });
		pushMessage(message);
	}
}

async function promptInner(message, images = []) {
	const userMessage = user(message, images);
	write({ type: "message_start", message: userMessage });
	write({ type: "message_end", message: userMessage });
	pushMessage(userMessage);

	if (SCREENSHOT_MODE) {
		screenshotTurn += 1;
		await screenshotPrompt(screenshotTurn);
		return;
	}

	if (message.startsWith("/")) {
		await streamAssistant([{ type: "text", text: `command accepted: ${message.split(/\s/)[0]}` }]);
		return;
	}

	if (message.includes("settitle")) {
		write({
			type: "extension_ui_request",
			id: `ui_${++session.sequence}`,
			method: "setTitle",
			title: "拡張タイトル",
		});
		await streamAssistant([{ type: "text", text: "タイトルを設定しました。" }]);
		return;
	}

	if (message.includes("statuswidget")) {
		write({
			type: "extension_ui_request",
			id: `ui_${++session.sequence}`,
			method: "setStatus",
			statusKey: "demo",
			statusText: "拡張ステータス",
		});
		write({
			type: "extension_ui_request",
			id: `ui_${++session.sequence}`,
			method: "setWidget",
			widgetKey: "demo",
			widgetLines: ["ウィジェット表示"],
		});
		await streamAssistant([{ type: "text", text: "状態を設定しました。" }]);
		return;
	}

	if (message.includes("plan")) {
		await planPrompt(message);
		return;
	}

	if (message.includes("edit")) {
		const { calls } = await streamAssistant([
			{
				type: "toolCall",
				name: "edit",
				args: {
					path: "src/demo.js",
					edits: [{ oldText: "const b = 2;", newText: "const b = 3;\nconst c = 4;" }],
				},
			},
		]);
		for (const call of calls) await runTool(call);
		await streamAssistant(
			[{ type: "text", text: "編集結果を確認しています。".repeat(message.includes("long") ? 50 : 8) }],
			{ slow: true },
		);
		return;
	}

	if (message.includes("blankthink")) {
		await streamAssistant([{ type: "thinking", text: "```\n```" }]);
		await streamAssistant([{ type: "text", text: "思考だけを確認しました。" }]);
		return;
	}

	if (message.includes("reason")) {
		const { calls } = await streamAssistant([
			{
				type: "thinking",
				text: "Let me inspect the architecture first.\nThen I will run one command.",
			},
			{ type: "toolCall", name: "bash", args: { command: "echo reason" } },
		]);
		for (const call of calls) await runTool(call);
		await streamAssistant([{ type: "text", text: "理由を確認しました。" }]);
		return;
	}

	if (message.includes("dupe")) {
		let { calls } = await streamAssistant([
			{ type: "thinking", text: "最初のコマンドを実行します。" },
			{ type: "toolCall", name: "bash", args: { command: "echo first" } },
		]);
		for (const call of calls) await runTool(call);
		({ calls } = await streamAssistant([
			{ type: "thinking", text: "続けて同じ種類と別の種類を実行します。" },
			{ type: "toolCall", name: "bash", args: { command: "echo second" } },
			{ type: "toolCall", name: "read", args: { path: "src/app.js" } },
		]));
		for (const call of calls) await runTool(call);
		await streamAssistant([{ type: "text", text: "重複をまとめました。" }]);
		return;
	}

	if (message.includes("slowwork")) {
		const { calls } = await streamAssistant(
			[
				{
					type: "thinking",
					text: `${"Let me examine the slow live path carefully. ".repeat(8)}
Then run one command.`,
				},
				{ type: "toolCall", name: "bash", args: { command: "echo slowwork" } },
			],
			{ slow: true },
		);
		for (const call of calls) await runTool(call);
		await streamAssistant([{ type: "text", text: "低速の理由を確認しました。" }]);
		return;
	}

	if (message.includes("silent")) {
		const { calls } = await streamAssistant([
			{ type: "toolCall", name: "bash", args: { command: "echo silent" } },
		]);
		for (const call of calls) await runTool(call);
		await streamAssistant([{ type: "text", text: "静かに完了しました。" }]);
		return;
	}

	if (message.includes("progress")) {
		const { calls } = await streamAssistant([
			{ type: "toolCall", name: "read", args: { path: "src/app.js" } },
			{ type: "toolCall", name: "grep", args: { pattern: "TODO" } },
			{ type: "toolCall", name: "bash", args: { command: "echo progress" } },
		]);
		for (const call of calls) await runTool(call);
		await streamAssistant(
			[{ type: "text", text: "進捗を確認しています。".repeat(80) }],
			{ slow: true },
		);
		return;
	}

	if (message.includes("tools")) {
		const { calls } = await streamAssistant([
			{ type: "thinking", text: "複数のツールをまとめて実行します。" },
			{ type: "text", text: "まとめて確認します。" },
			{ type: "toolCall", name: "bash", args: { command: "echo one" } },
			{ type: "toolCall", name: "read", args: { path: "src/app.js" } },
			{ type: "toolCall", name: "grep", args: { pattern: "TODO" } },
		]);
		for (const call of calls) await runTool(call);
		await streamAssistant([{ type: "text", text: "すべて完了しました。" }]);
		return;
	}

	if (message.includes("fail")) {
		const { calls } = await streamAssistant([
			{ type: "thinking", text: "失敗するツールを試します。" },
			{ type: "text", text: "ツールを実行します。" },
			{ type: "toolCall", name: "bash", args: { command: "exit 1" } },
		]);
		for (const call of calls) await runTool(call, { isError: true });
		await streamAssistant([{ type: "text", text: "失敗しました。" }]);
		return;
	}

	if (message.includes("die")) {
		process.exit(1);
	}

	if (message.includes("ask")) {
		const id = `ui_${++session.sequence}`;
		const answer = await new Promise((resolve) => {
			session.uiWaiters.set(id, resolve);
			write({
				type: "extension_ui_request",
				id,
				method: "confirm",
				title: "実行しますか？",
				message: "危険なコマンドを実行しようとしています。",
			});
		});
		await streamAssistant([{ type: "text", text: `confirmed=${answer?.confirmed === true}` }]);
		return;
	}

	if (message.includes("long")) {
		await streamAssistant(
			[
				{
					type: "text",
					text: Array.from({ length: 130 }, (_, index) => `chunk ${index}`).join(" "),
				},
			],
			{ slow: true },
		);
		return;
	}

	if (message.includes("xss")) {
		await streamAssistant([
			{
				type: "text",
				text: 'raw <img src=x onerror="window.__xss=1"> and <script>window.__xss=2</script> [click](javascript:window.__xss=3) done',
			},
		]);
		return;
	}

	await streamAssistant([
		{ type: "thinking", text: "ユーザーの依頼を確認して、必要なツールを選びます。" },
		{ type: "text", text: "確認します。echo を実行します。" },
		{ type: "toolCall", name: "bash", args: { command: "echo hi" } },
	]);
	await runTool();
	await streamAssistant([
		{
			type: "text",
			text: [
				"## 結果",
				"`echo hi` を実行しました。",
				"",
				"| 項目 | 値 |",
				"| --- | --- |",
				"| 状態 | OK |",
				"| 出力 | hi |",
				"",
				"```js",
				"const answer = 42;",
				"```",
			].join("\n"),
		},
	]);
}

async function handle(record) {
	const { id, type } = record;
	switch (type) {
		case "get_state":
			respond(id, type, {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.running,
				isCompacting: false,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				...(session.sessionName ? { sessionName: session.sessionName } : {}),
				messageCount: session.messages.length,
				pendingMessageCount: 0,
			});
			return;
		case "get_messages":
			respond(id, type, { messages: session.messages });
			return;
		case "get_entries":
			respond(id, type, { entries: session.entries, leafId: session.leafId });
			return;
		case "get_session_stats":
			respond(id, type, {
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				userMessages: session.messages.filter((message) => message.role === "user").length,
				assistantMessages: session.messages.filter((message) => message.role === "assistant").length,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: session.messages.length,
				tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
				cost: session.cost,
				contextUsage: session.contextUnknown
					? { tokens: null, contextWindow: session.model.contextWindow, percent: null }
					: {
							tokens: session.contextTokens,
							contextWindow: session.model.contextWindow,
							percent: (session.contextTokens / session.model.contextWindow) * 100,
						},
			});
			return;
		case "get_available_models":
			respond(id, type, { models: MODELS });
			return;
		case "get_available_thinking_levels":
			respond(id, type, {
				levels: session.model.reasoning ? ["off", "low", "medium", "high"] : ["off"],
			});
			return;
		case "get_commands":
			respond(id, type, { commands: COMMANDS });
			return;
		case "set_model": {
			const model = MODELS.find(
				(candidate) => candidate.provider === record.provider && candidate.id === record.modelId,
			);
			if (!model) {
				respond(id, type, undefined, `Model not found: ${record.provider}/${record.modelId}`);
				return;
			}
			session.model = model;
			respond(id, type, model);
			return;
		}
		case "set_thinking_level":
			session.thinkingLevel = record.level;
			write({ type: "thinking_level_changed", level: record.level });
			respond(id, type);
			return;
		case "set_session_name":
			session.sessionName = record.name;
			write({ type: "session_info_changed", name: record.name });
			respond(id, type);
			return;
		case "new_session":
			session.messages = [];
			session.entries = [];
			session.leafId = null;
			session.nextEntry = 1;
			session.plan = null;
			session.sessionId = `fake-${++session.sequence}`;
			session.sessionFile = undefined;
			session.sessionName = undefined;
			respond(id, type, { cancelled: false });
			return;
		case "switch_session": {
			const path = record.sessionPath;
			try {
				await openSession(path);
				respond(id, type, { cancelled: false });
			} catch (error) {
				respond(id, type, undefined, error.message);
			}
			return;
		}
		case "prompt":
			if (session.running && record.streamingBehavior) {
				if (record.streamingBehavior === "followUp") {
					session.followUp.push(record.message);
				} else {
					session.steering.push(record.message);
				}
				write({ type: "queue_update", steering: [...session.steering], followUp: [...session.followUp] });
				respond(id, type, { disposition: "queued" });
				return;
			}
			respond(id, type, { disposition: session.running ? "queued" : "started" });
			if (!session.running) prompt(record.message, record.images ?? []).catch(() => {});
			return;
		case "steer":
			session.steering.push(record.message);
			write({ type: "queue_update", steering: [...session.steering], followUp: [...session.followUp] });
			respond(id, type, { disposition: "queued" });
			return;
		case "follow_up":
			session.followUp.push(record.message);
			write({ type: "queue_update", steering: [...session.steering], followUp: [...session.followUp] });
			respond(id, type, { disposition: "queued" });
			return;
		case "abort":
			session.aborted = true;
			await sleep(180);
			respond(id, type);
			return;
		case "clear_queue": {
			const steering = [...session.steering];
			const followUp = [...session.followUp];
			session.steering = [];
			session.followUp = [];
			write({ type: "queue_update", steering: [], followUp: [] });
			respond(id, type, { steering, followUp });
			return;
		}
		case "set_auto_compaction":
		case "set_auto_retry":
			respond(id, type);
			return;
		case "compact":
			session.contextUnknown = true;
			respond(id, type, {
				summary: "compacted",
				firstKeptEntryId: "x",
				tokensBefore: 1000,
				estimatedTokensAfter: 100,
			});
			return;
		case "extension_ui_response": {
			const waiter = session.uiWaiters.get(record.id);
			if (waiter) {
				session.uiWaiters.delete(record.id);
				waiter(record);
			}
			return;
		}
		default:
			respond(id, type, undefined, `Unsupported command: ${type}`);
	}
}
