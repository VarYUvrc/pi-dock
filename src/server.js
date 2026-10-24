import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiBridge } from "./pi.js";
import { LiveState } from "./live.js";
import { PLAN_STATE_ENTRY, PLAN_TOOL, normalizePlan, planFromEntries } from "./plan.js";
import {
	deleteSessionFile,
	listSessions,
	resolveSessionTargets,
} from "./sessions.js";
import {
	clearCompactionThreshold,
	describeCompaction,
	setCompactionEnabled,
	setCompactionThreshold,
} from "./compaction.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PLAN_EXTENSION = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"extension",
	"dock-plan.ts",
);
const MAX_BODY = 12 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

const ASSETS = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/index.html": ["index.html", "text/html; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
	"/theme-init.js": ["theme-init.js", "text/javascript; charset=utf-8"],
	"/style.css": ["style.css", "text/css; charset=utf-8"],
};

// Only commands the UI needs are reachable from the browser.
const FORWARDED = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"clear_queue",
	"new_session",
	"switch_session",
	"set_model",
	"set_thinking_level",
	"compact",
	"set_session_name",
	"get_state",
	"get_messages",
	"get_session_stats",
	"get_available_models",
	"get_available_thinking_levels",
	"get_commands",
	"get_entries",
	"get_tree",
	"export_html",
]);

const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPi(bridge, timeout = 30_000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		if (bridge.lastExit) throw new Error(bridge.lastExit.reason);
		try {
			await bridge.request({ type: "get_state" }, { timeout: 4000 });
			return;
		} catch {
			await delay(250);
		}
	}
	throw new Error(bridge.lastExit?.reason ?? "Pi の起動がタイムアウトしました");
}

function publicModel(model) {
	if (!model) return null;
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider: model.provider,
		reasoning: Boolean(model.reasoning),
		contextWindow: model.contextWindow,
	};
}

function validateImages(images) {
	if (images === undefined) return undefined;
	if (!Array.isArray(images) || images.length > 6) throw new Error("画像の形式が不正です");
	return images.map((image) => {
		if (
			!image ||
			image.type !== "image" ||
			typeof image.data !== "string" ||
			typeof image.mimeType !== "string" ||
			image.data.length > MAX_BODY
		) {
			throw new Error("画像の形式が不正です");
		}
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

export async function createDock({
	cwd,
	launcher,
	env = process.env,
	token = randomBytes(24).toString("base64url"),
	port = 0,
	host = "127.0.0.1",
	piArgs = [],
}) {
	const assets = new Map();
	for (const [path, [file, type]] of Object.entries(ASSETS)) {
		assets.set(path, { body: await readFile(join(PUBLIC_DIR, file)), type });
	}

	const clients = new Set();
	const runtimes = new Map();
	let activeRuntime = null;
	let runtimeSequence = 0;
	let closing = false;
	let actualPort = port;

	const sessionKey = (value) =>
		process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);

	function runtimeSummary(runtime) {
		return {
			id: runtime.id,
			sessionId: runtime.sessionId,
			sessionFile: runtime.sessionFile,
			sessionName: runtime.sessionName,
			running: runtime.running,
			exited: Boolean(runtime.exit),
		};
	}

	async function refreshRuntimeState(runtime) {
		if (!runtime.bridge.running) return null;
		const state = await runtime.bridge
			.request({ type: "get_state" }, { timeout: 5000 })
			.catch(() => null);
		if (!state) return null;
		runtime.sessionId = state.sessionId ?? runtime.sessionId;
		if (state.sessionFile !== undefined) runtime.sessionFile = state.sessionFile;
		if (state.sessionName !== undefined) runtime.sessionName = state.sessionName;
		runtime.running = Boolean(state.isStreaming);
		if (runtime.running && !runtime.runStartedAt) runtime.runStartedAt = Date.now();
		if (!runtime.running && runtime.runStartedAt && !state.isStreaming) {
			runtime.runStartedAt = null;
		}
		return state;
	}

	function makeRuntime({ sessionPath = "", initial = false } = {}) {
		const id = `r${++runtimeSequence}`;
		const bridge = new PiBridge({
			cwd,
			launcher,
			env,
			piArgs: initial
				? ["--extension", PLAN_EXTENSION, ...piArgs]
				: ["--extension", PLAN_EXTENSION, ...(sessionPath ? ["--session", sessionPath] : [])],
		});
		const runtime = {
			id,
			bridge,
			live: new LiveState(),
			sessionId: "",
			sessionFile: sessionPath,
			sessionName: "",
			running: false,
			runStartedAt: null,
			startedAt: Date.now(),
			exit: null,
			pendingUi: new Map(),
		};
		runtimes.set(id, runtime);
		bridge.on("record", (record) => onRuntimeRecord(runtime, record));
		bridge.on("exit", (info) => onRuntimeExit(runtime, info));
		bridge.start();
		return runtime;
	}

	/** @param {import("./pi-protocol.js").PiRecord} record */
	function onRuntimeRecord(runtime, record) {
		runtime.live.apply(record);
		if (record.type === "session_info_changed") {
			runtime.sessionName = record.name ?? "";
		}
		if (record.type === "agent_start") {
			runtime.running = true;
			if (!runtime.runStartedAt) runtime.runStartedAt = Date.now();
		}
		if (record.type === "agent_settled") {
			runtime.running = false;
			runtime.runStartedAt = null;
			refreshRuntimeState(runtime).catch(() => {});
		}
		if (
			record.type === "extension_ui_request" &&
			["select", "confirm", "input", "editor"].includes(record.method)
		) {
			runtime.pendingUi.set(record.id, record);
		}

		if (runtime !== activeRuntime) {
			if (
				[
					"agent_start",
					"agent_settled",
					"session_info_changed",
					"compaction_start",
					"compaction_end",
					"auto_retry_start",
					"auto_retry_end",
				].includes(record.type)
			) {
				broadcast({ type: "dock:runtime", runtime: runtimeSummary(runtime) });
			}
			return;
		}

		broadcast({
			...record,
			runtime: runtime.id,
			...(record.type === "agent_start" ? { runStartedAt: runtime.runStartedAt } : {}),
		});
		if (record.type === "tool_execution_end" && record.toolName === PLAN_TOOL) {
			broadcast({
				type: "dock:plan",
				runtime: runtime.id,
				plan: normalizePlan(record.result?.details),
			});
		}
		if (
			record.type === "message_end" &&
			record.message?.role === "toolResult" &&
			record.message.toolName === PLAN_TOOL
		) {
			broadcast({
				type: "dock:plan",
				runtime: runtime.id,
				plan: normalizePlan(record.message.details),
			});
		}
		if (
			record.type === "entry_appended" &&
			record.entry?.type === "custom" &&
			record.entry.customType === PLAN_STATE_ENTRY
		) {
			broadcast({
				type: "dock:plan",
				runtime: runtime.id,
				plan: normalizePlan(record.entry.data),
			});
		}
	}

	function onRuntimeExit(runtime, info) {
		runtime.live.reset();
		runtime.running = false;
		runtime.runStartedAt = null;
		runtime.exit = info;
		if (runtime === activeRuntime) {
			broadcast({ type: "dock:exit", runtime: runtime.id, reason: info.reason });
			return;
		}
		runtimes.delete(runtime.id);
		broadcast({ type: "dock:runtime", runtime: runtimeSummary(runtime) });
	}

	async function startRuntime(options = {}) {
		const runtime = makeRuntime(options);
		try {
			await waitForPi(runtime.bridge);
			await refreshRuntimeState(runtime);
			return runtime;
		} catch (error) {
			await runtime.bridge.stop().catch(() => {});
			runtimes.delete(runtime.id);
			throw error;
		}
	}

	function activateRuntime(runtime) {
		if (activeRuntime && activeRuntime !== runtime && activeRuntime.exit) {
			runtimes.delete(activeRuntime.id);
		}
		activeRuntime = runtime;
		return runtime;
	}

	function findRuntimeByPath(path) {
		const key = sessionKey(path);
		for (const runtime of runtimes.values()) {
			if (runtime.sessionFile && sessionKey(runtime.sessionFile) === key) return runtime;
		}
		return null;
	}

	function requireRuntime() {
		if (!activeRuntime) throw new Error("Pi に接続されていません");
		if (activeRuntime.exit) throw new Error(activeRuntime.exit.reason);
		return activeRuntime;
	}

	async function dockSessions() {
		await Promise.all(
			[...runtimes.values()]
				.filter((runtime) => runtime.bridge.running)
				.map((runtime) => refreshRuntimeState(runtime)),
		);
		const currentId = activeRuntime?.sessionId ?? "";
		const sessions = await listSessions({ cwd, currentId, env });
		const bySessionId = new Map();
		for (const runtime of runtimes.values()) {
			if (runtime.sessionId && !runtime.exit) bySessionId.set(runtime.sessionId, runtime);
		}
		const represented = new Set(sessions.map((session) => session.id));
		const live = [];
		for (const runtime of runtimes.values()) {
			if (!runtime.sessionId || runtime.exit || represented.has(runtime.sessionId)) continue;
			live.push({
				path: runtime.sessionFile,
				id: runtime.sessionId,
				name: runtime.sessionName,
				preview: "",
				created: "",
				modified: new Date(runtime.startedAt).toISOString(),
				size: 0,
				current: runtime === activeRuntime,
				runtime: runtime.id,
				running: runtime.running,
				live: true,
			});
		}
		const all = [
			...live.sort((a, b) => b.modified.localeCompare(a.modified)),
			...sessions.map((session) => {
				const runtime = bySessionId.get(session.id);
				return {
					...session,
					runtime: runtime?.id ?? null,
					running: Boolean(runtime?.running),
					live: Boolean(runtime),
				};
			}),
		];
		return { sessions: all, total: all.length };
	}

	function broadcast(record) {
		if (clients.size === 0) return;
		const frame = `data: ${JSON.stringify(record)}\n\n`;
		for (const client of clients) {
			try {
				client.write(frame);
			} catch {
				clients.delete(client);
			}
		}
	}

	async function snapshot() {
		const runtime = requireRuntime();
		const bridge = runtime.bridge;
		const [state, messages, stats, models, levels, commands, entries] = await Promise.all([
			bridge.request({ type: "get_state" }),
			bridge.request({ type: "get_messages" }),
			bridge.request({ type: "get_session_stats" }).catch(() => null),
			bridge.request({ type: "get_available_models" }).catch(() => null),
			bridge.request({ type: "get_available_thinking_levels" }).catch(() => null),
			bridge.request({ type: "get_commands" }).catch(() => null),
			bridge.request({ type: "get_entries" }).catch(() => null),
		]);
		if (state) {
			runtime.sessionId = state.sessionId ?? runtime.sessionId;
			if (state.sessionFile !== undefined) runtime.sessionFile = state.sessionFile;
			if (state.sessionName !== undefined) runtime.sessionName = state.sessionName;
			runtime.running = Boolean(state.isStreaming);
			if (runtime.running && !runtime.runStartedAt) runtime.runStartedAt = Date.now();
			if (!runtime.running) runtime.runStartedAt = null;
		}
		const compaction = await describeCompaction({ cwd, env, model: state?.model });
		return {
			runtime: runtime.id,
			cwd,
			state,
			runStartedAt: runtime.runStartedAt,
			live: runtime.live.snapshot(),
			messages: Array.isArray(messages?.messages) ? messages.messages : [],
			stats: stats ?? null,
			models: (models?.models ?? []).map(publicModel),
			levels: levels?.levels ?? ["off"],
			commands: commands?.commands ?? [],
			plan: entries ? planFromEntries(entries.entries, entries.leafId) : null,
			pendingUi: [...runtime.pendingUi.values()],
			compaction,
		};
	}

	async function currentModel() {
		const state = await requireRuntime().bridge.request({ type: "get_state" });
		if (!state?.model) throw new Error("モデルが選択されていません");
		return state.model;
	}

	async function handleRpc(command) {
		if (!command || typeof command !== "object" || typeof command.type !== "string") {
			throw new Error("コマンドが不正です");
		}

		if (command.type === "dock:snapshot") return snapshot();
		if (command.type === "dock:sessions") return await dockSessions();
		if (command.type === "dock:activate") {
			const runtime = runtimes.get(String(command.runtimeId));
			if (!runtime || runtime.exit) throw new Error("セッションが見つかりません");
			activateRuntime(runtime);
			return { runtime: runtime.id };
		}
		if (command.type === "dock:restart") {
			const runtime = activeRuntime;
			if (!runtime) throw new Error("Pi に接続されていません");
			runtime.exit = null;
			await runtime.bridge.restart();
			await waitForPi(runtime.bridge);
			runtime.live.reset();
			await refreshRuntimeState(runtime);
			return { restarted: true };
		}
		if (command.type === "dock:delete_sessions") {
			const all = command.all === true;
			const ids = Array.isArray(command.ids)
				? command.ids.filter((id) => typeof id === "string" && id)
				: null;
			if (!all && (!ids || ids.length === 0)) {
				throw new Error("削除対象が指定されていません");
			}
			const { targets, missing } = await resolveSessionTargets({
				cwd,
				ids,
				all,
				env,
			});
			const protectedPaths = new Set();
			const protectedIds = new Set();
			for (const runtime of runtimes.values()) {
				if (runtime.exit) continue;
				if (runtime !== activeRuntime && !runtime.running) continue;
				if (runtime.sessionFile) protectedPaths.add(sessionKey(runtime.sessionFile));
				if (runtime.sessionId) protectedIds.add(runtime.sessionId);
			}

			const failed = missing.map((id) => ({
				id,
				error: "セッションが見つかりません",
			}));
			let deleted = 0;
			for (const target of targets) {
				if (
					protectedPaths.has(sessionKey(target.path)) ||
					protectedIds.has(target.id)
				) {
					failed.push({ id: target.id, error: "使用中のセッションは削除できません" });
					continue;
				}
				const runtime =
					findRuntimeByPath(target.path) ??
					[...runtimes.values()].find(
						(candidate) => !candidate.exit && candidate.sessionId === target.id,
					);
				if (runtime) {
					if (runtime.running) {
						failed.push({
							id: target.id,
							error: "実行中のセッションは削除できません",
						});
						continue;
					}
					// A background session may have been opened earlier in this
					// Dock run. Stop it before removing the file it writes to.
					await runtime.bridge.stop().catch(() => {});
					runtimes.delete(runtime.id);
				}
				try {
					await deleteSessionFile({ cwd, path: target.path, env });
					deleted += 1;
				} catch (error) {
					failed.push({ id: target.id, error: error.message });
				}
			}
			return { deleted, failed };
		}
		if (command.type === "new_session") {
			const runtime = await startRuntime();
			activateRuntime(runtime);
			return { cancelled: false, runtime: runtime.id };
		}
		if (command.type === "switch_session") {
			if (typeof command.sessionPath !== "string") throw new Error("パスが不正です");
			const runtime =
				findRuntimeByPath(command.sessionPath) ??
				(await startRuntime({ sessionPath: command.sessionPath }));
			activateRuntime(runtime);
			return { cancelled: false, runtime: runtime.id };
		}
		if (command.type === "dock:set_compaction") {
			const model = await currentModel();
			if (command.action === "enable") {
				await setCompactionEnabled({ env, enabled: command.enabled !== false });
			} else if (command.action === "clear") {
				await clearCompactionThreshold({ cwd, env, model });
			} else {
				await setCompactionThreshold({
					cwd,
					env,
					model,
					percent: Number(command.percent),
				});
			}
			return { compaction: await describeCompaction({ cwd, env, model }) };
		}
		if (command.type === "dock:extension_ui_response") {
			if (typeof command.id !== "string") throw new Error("id が不正です");
			const runtime = command.runtimeId
				? runtimes.get(String(command.runtimeId))
				: requireRuntime();
			if (!runtime) throw new Error("セッションが見つかりません");
			const response = {
				type: "extension_ui_response",
				id: command.id,
				...(command.cancelled
					? { cancelled: true }
					: command.confirmed !== undefined
						? { confirmed: Boolean(command.confirmed) }
						: { value: String(command.value ?? "") }),
			};
			runtime.pendingUi.delete(command.id);
			runtime.bridge.sendRaw(response);
			return { sent: true };
		}
		if (!FORWARDED.has(command.type)) throw new Error("未対応のコマンドです");

		const payload = { type: command.type };
		if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
			if (typeof command.message !== "string" || !command.message.trim()) {
				throw new Error("メッセージが空です");
			}
			payload.message = command.message;
			const images = validateImages(command.images);
			if (images) payload.images = images;
			if (command.streamingBehavior) payload.streamingBehavior = command.streamingBehavior;
		}
		if (command.type === "set_model") {
			if (typeof command.provider !== "string" || typeof command.modelId !== "string") {
				throw new Error("モデルが不正です");
			}
			payload.provider = command.provider;
			payload.modelId = command.modelId;
		}
		if (command.type === "set_thinking_level") {
			if (typeof command.level !== "string") throw new Error("level が不正です");
			payload.level = command.level;
		}
		if (command.type === "set_session_name") {
			if (typeof command.name !== "string") throw new Error("name が不正です");
			payload.name = command.name;
		}
		if (command.type === "compact" && typeof command.customInstructions === "string") {
			payload.customInstructions = command.customInstructions;
		}
		return await requireRuntime().bridge.request(payload, {
			timeout: command.type === "abort" ? 90_000 : 60_000,
		});
	}

	function cookieToken(request) {
		const header = request.headers.cookie;
		if (typeof header !== "string") return null;
		for (const part of header.split(";")) {
			const separator = part.indexOf("=");
			if (separator === -1) continue;
			if (part.slice(0, separator).trim() !== "pi_dock") continue;
			try {
				return decodeURIComponent(part.slice(separator + 1).trim());
			} catch {
				return null;
			}
		}
		return null;
	}

	function authorized(request, url) {
		const header = request.headers["x-pi-dock-token"];
		if (typeof header === "string" && header === token) return true;
		if (cookieToken(request) === token) return true;
		return (
			url.searchParams.get("launch") === token || url.searchParams.get("token") === token
		);
	}

	function hostAllowed(request) {
		const header = request.headers.host;
		if (!header) return false;
		const match = /^(.*):(\d+)$/.exec(header);
		if (!match) return false;
		if (match[2] !== String(actualPort)) return false;
		return match[1] === "127.0.0.1" || match[1] === "localhost" || match[1] === "[::1]";
	}

	function json(response, status, body) {
		const payload = JSON.stringify(body);
		response.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(payload),
		});
		response.end(payload);
	}

	function readBody(request) {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks = [];
			request.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY) {
					reject(new Error("リクエストが大きすぎます"));
					request.destroy();
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			request.on("error", reject);
		});
	}

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

		if (!hostAllowed(request)) {
			response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
			response.end("Misdirected request");
			return;
		}

		if (
			request.method === "GET" &&
			url.pathname === "/" &&
			(url.searchParams.has("launch") || url.searchParams.has("token"))
		) {
			if (!authorized(request, url)) {
				response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				response.end("Unauthorized — open the URL printed by pi-dock");
				return;
			}
			// Exchange the launch credential for a localhost cookie and redirect to
			// a clean address. The credential itself stays as strong as before.
			response.writeHead(303, {
				location: "/",
				"set-cookie": `pi_dock=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			response.end();
			return;
		}

		if (url.pathname === "/api/events") {
			if (!authorized(request, url)) {
				response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				response.end("Unauthorized");
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			response.write("retry: 3000\n\n");
			response.write(`data: ${JSON.stringify({ type: "dock:hello", cwd })}\n\n`);
			clients.add(response);
			request.on("close", () => clients.delete(response));
			response.on("error", () => clients.delete(response));
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/rpc") {
			const origin = request.headers.origin;
			if (origin && origin !== `http://${request.headers.host}`) {
				json(response, 403, { ok: false, error: "Forbidden" });
				return;
			}
			if (!authorized(request, url)) {
				json(response, 401, { ok: false, error: "Unauthorized" });
				return;
			}
			let command;
			try {
				command = JSON.parse(await readBody(request));
			} catch (error) {
				json(response, 400, { ok: false, error: error.message });
				return;
			}
			try {
				json(response, 200, { ok: true, data: await handleRpc(command) });
			} catch (error) {
				json(response, 200, { ok: false, error: error.message });
			}
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
			response.end("Method not allowed");
			return;
		}

		const asset = assets.get(url.pathname);
		if (!asset) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		// The HTML shell needs the session token; the assets it references do not
		// contain any secret and are served without one so the page can boot.
		const needsToken = asset.type.startsWith("text/html");
		if (needsToken && !authorized(request, url)) {
			response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			response.end("Unauthorized — open the URL printed by pi-dock");
			return;
		}
		response.writeHead(200, {
			"content-type": asset.type,
			"cache-control": "no-store",
			"content-security-policy": CONTENT_SECURITY_POLICY,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		});
		response.end(request.method === "HEAD" ? undefined : asset.body);
	});

	const heartbeat = setInterval(() => {
		for (const client of clients) {
			try {
				client.write(": ping\n\n");
			} catch {
				clients.delete(client);
			}
		}
	}, HEARTBEAT_MS);
	heartbeat.unref();

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	actualPort = typeof address === "object" && address ? address.port : port;

	try {
		activateRuntime(await startRuntime({ initial: true }));
	} catch (error) {
		server.close();
		throw error;
	}

	return {
		server,
		token,
		port: actualPort,
		url: `http://${host}:${actualPort}/?launch=${encodeURIComponent(token)}`,
		get sessionName() {
			return activeRuntime?.sessionName;
		},
		async close() {
			if (closing) return;
			closing = true;
			clearInterval(heartbeat);
			for (const client of clients) {
				try {
					client.end();
				} catch {
					/* ignore */
				}
			}
			clients.clear();
			await Promise.all([...runtimes.values()].map((runtime) => runtime.bridge.stop()));
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
