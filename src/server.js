import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiBridge } from "./pi.js";
import { LiveState } from "./live.js";
import { PLAN_TOOL, normalizePlan, planFromEntries } from "./plan.js";
import { listSessions } from "./sessions.js";

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

	const bridge = new PiBridge({
		cwd,
		launcher,
		env,
		piArgs: ["--extension", PLAN_EXTENSION, ...piArgs],
	});
	const live = new LiveState();
	const clients = new Set();
	let sessionName;
	let closing = false;
	let actualPort = port;

	bridge.on("record", (record) => {
		live.apply(record);
		if (record.type === "session_info_changed") sessionName = record.name;
		broadcast(record);
		if (record.type === "tool_execution_end" && record.toolName === PLAN_TOOL) {
			broadcast({ type: "dock:plan", plan: normalizePlan(record.result?.details) });
		}
		if (
			record.type === "message_end" &&
			record.message?.role === "toolResult" &&
			record.message.toolName === PLAN_TOOL
		) {
			broadcast({ type: "dock:plan", plan: normalizePlan(record.message.details) });
		}
	});
	bridge.on("exit", (info) => {
		live.reset();
		broadcast({ type: "dock:exit", reason: info.reason });
	});

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
		const [state, messages, stats, models, levels, commands, entries] = await Promise.all([
			bridge.request({ type: "get_state" }),
			bridge.request({ type: "get_messages" }),
			bridge.request({ type: "get_session_stats" }).catch(() => null),
			bridge.request({ type: "get_available_models" }).catch(() => null),
			bridge.request({ type: "get_available_thinking_levels" }).catch(() => null),
			bridge.request({ type: "get_commands" }).catch(() => null),
			bridge.request({ type: "get_entries" }).catch(() => null),
		]);
		if (state?.sessionName !== undefined) sessionName = state.sessionName;
		return {
			cwd,
			state,
			live: live.snapshot(),
			messages: Array.isArray(messages?.messages) ? messages.messages : [],
			stats: stats ?? null,
			models: (models?.models ?? []).map(publicModel),
			levels: levels?.levels ?? ["off"],
			commands: commands?.commands ?? [],
			plan: entries ? planFromEntries(entries.entries, entries.leafId) : null,
		};
	}

	async function handleRpc(command) {
		if (!command || typeof command !== "object" || typeof command.type !== "string") {
			throw new Error("コマンドが不正です");
		}

		if (command.type === "dock:snapshot") return snapshot();
		if (command.type === "dock:sessions") {
			const state = await bridge.request({ type: "get_state" });
			return await listSessions({ cwd, currentId: state?.sessionId, env });
		}
		if (command.type === "dock:restart") {
			await bridge.restart();
			await waitForPi(bridge);
			live.reset();
			return { restarted: true };
		}
		if (command.type === "dock:extension_ui_response") {
			if (typeof command.id !== "string") throw new Error("id が不正です");
			const response = {
				type: "extension_ui_response",
				id: command.id,
				...(command.cancelled
					? { cancelled: true }
					: command.confirmed !== undefined
						? { confirmed: Boolean(command.confirmed) }
						: { value: String(command.value ?? "") }),
			};
			bridge.sendRaw(response);
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
		if (command.type === "switch_session") {
			if (typeof command.sessionPath !== "string") throw new Error("パスが不正です");
			payload.sessionPath = command.sessionPath;
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
		return await bridge.request(payload, {
			timeout: command.type === "abort" ? 90_000 : 60_000,
		});
	}

	function authorized(request, url) {
		const header = request.headers["x-pi-dock-token"];
		if (typeof header === "string" && header === token) return true;
		return url.searchParams.get("token") === token;
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
	actualPort = server.address().port;

	bridge.start();
	try {
		await waitForPi(bridge);
	} catch (error) {
		await bridge.stop();
		server.close();
		throw error;
	}

	return {
		server,
		token,
		port: actualPort,
		url: `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`,
		get sessionName() {
			return sessionName;
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
			await bridge.stop();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
