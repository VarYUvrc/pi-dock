#!/usr/bin/env node
// E2E fixture that speaks the Pi RPC protocol. It never touches the network or
// the user's Pi configuration; the dock tests drive this instead of a real model.
import { readFile } from "node:fs/promises";

const MODELS = [
	{
		id: "fake-fast",
		name: "Fake Fast",
		provider: "fake",
		api: "fake-api",
		reasoning: false,
		contextWindow: 32_000,
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
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
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

function write(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(id, command, data, error) {
	write({
		id,
		type: "response",
		command,
		success: error === undefined,
		...(error === undefined ? { data } : { error }),
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function user(content, images = []) {
	return {
		role: "user",
		content: images.length ? [{ type: "text", text: content }, ...images] : content,
		timestamp: Date.now(),
	};
}

function pushMessage(message) {
	const id = `e${Date.now().toString(36)}${(session.nextEntry++).toString(36)}`;
	session.entries.push({
		type: "message",
		id,
		parentId: session.leafId,
		timestamp: new Date().toISOString(),
		message,
	});
	session.leafId = id;
	session.messages.push(message);
}

function formatPlan(plan) {
	const marks = { done: "[x]", in_progress: "[>]", pending: "[ ]", cancelled: "[-]" };
	const lines = plan.title ? [plan.title] : [];
	for (const item of plan.items) lines.push(`${marks[item.status]} ${item.id}: ${item.text}`);
	return lines.length ? lines.join("\n") : "No plan";
}

function applyPlan(args) {
	const existing = new Map((session.plan?.items ?? []).map((item) => [item.id, item]));
	let items = (session.plan?.items ?? []).map((item) => ({ ...item }));
	let nextId = session.plan?.nextId ?? 1;
	let title = session.plan?.title;
	if (args.action === "set") {
		items = [];
		for (const raw of args.items ?? []) {
			const current = raw.id ? existing.get(raw.id) : undefined;
			const text = raw.text ?? current?.text;
			const id = current ? current.id : `p${nextId++}`;
			items.push({ id, text, status: raw.status ?? current?.status ?? "pending" });
		}
		title = args.title;
	} else if (args.action === "add") {
		items.push({ id: `p${nextId++}`, text: args.text, status: args.status ?? "pending" });
	} else if (args.action === "update") {
		const item = items.find((candidate) => candidate.id === args.id);
		if (item) {
			if (args.text) item.text = args.text;
			if (args.status) item.status = args.status;
		}
	} else if (args.action === "remove") {
		items = items.filter((item) => item.id !== args.id);
	} else if (args.action === "clear") {
		items = [];
		nextId = 1;
		title = undefined;
	}
	session.plan = { ...(title ? { title } : {}), items, nextId };
	return {
		content: [{ type: "text", text: formatPlan(session.plan) }],
		details: { ...session.plan, action: args.action },
	};
}

async function streamAssistant(parts, { slow = false } = {}) {
	const delay = slow ? Math.max(SLOW, 28) : SLOW;
	session.running = true;
	session.aborted = false;
	const calls = [];
	write({ type: "agent_start" });
	const started = Date.now();
	write({ type: "message_start", message: assistant([], "pending") });
	const content = [];
	for (const [index, part] of parts.entries()) {
		if (part.type === "thinking") {
			write({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: index } });
			for (const delta of chunk(part.text)) {
				if (session.aborted) break;
				session.contextTokens += 3;
				write({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta },
				});
				await sleep(delay);
			}
			write({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end", contentIndex: index, content: part.text },
			});
			content[index] = { type: "thinking", thinking: part.text };
		} else if (part.type === "text") {
			write({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: index } });
			for (const delta of chunk(part.text)) {
				if (session.aborted) break;
				session.contextTokens += 5;
				write({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
				});
				await sleep(delay);
			}
			write({
				type: "message_update",
				assistantMessageEvent: { type: "text_end", contentIndex: index, content: part.text },
			});
			content[index] = { type: "text", text: part.text };
		} else if (part.type === "toolCall") {
			const id = `call_${++session.sequence}`;
			session.lastToolCall = { id, name: part.name, arguments: part.args };
			calls.push(session.lastToolCall);
			write({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id, toolName: part.name },
			});
			const json = JSON.stringify(part.args);
			for (const delta of chunk(json, 6)) {
				if (session.aborted) break;
				write({
					type: "message_update",
					assistantMessageEvent: { type: "toolcall_delta", contentIndex: index, delta },
				});
				await sleep(4);
			}
			write({
				type: "message_update",
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
	write({ type: "agent_end", messages: [final], willRetry: false });
	session.running = false;
	session.contextUnknown = false;
	write({ type: "agent_settled", aborted: session.aborted });
	session.aborted = false;
	return { durationMs: Date.now() - started, calls };
}

async function runTool(call = session.lastToolCall, { isError = false } = {}) {
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
		partialResult: { content: [{ type: "text", text: "partial" }] },
	});
	await sleep(20);
	const outcome =
		call.name === "dock_plan"
			? applyPlan(call.arguments)
			: {
					content: [{ type: "text", text: isError ? "boom from fake pi\n" : "hi from fake pi\n" }],
					details: {},
				};
	session.contextTokens += 700;
	write({
		type: "tool_execution_end",
		toolCallId: call.id,
		toolName: call.name,
		result: outcome,
		isError,
		durationMs: 41,
	});
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
	await streamAssistant([{ type: "toolCall", name: "dock_plan", args }]);
	await runTool();
	await streamAssistant([{ type: "text", text: `plan action: ${args.action}` }]);
}

async function prompt(message, images = []) {
	const userMessage = user(message, images);
	write({ type: "message_start", message: userMessage });
	write({ type: "message_end", message: userMessage });
	pushMessage(userMessage);

	if (message.startsWith("/")) {
		await streamAssistant([{ type: "text", text: `command accepted: ${message.split(/\s/)[0]}` }]);
		return;
	}

	if (message.includes("plan")) {
		await planPrompt(message);
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
				cost: 0.001,
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
				session.plan = null;
				session.messages = entries
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message);
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
