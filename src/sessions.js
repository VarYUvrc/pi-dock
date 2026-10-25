import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

/** @typedef {import("./pi-protocol.js").PiContent} PiContent */
/** @typedef {import("./pi-protocol.js").PiSessionLine} PiSessionLine */
/** @typedef {import("./pi-protocol.js").PiTextBlock} PiTextBlock */
/** @typedef {{ id: string, cwd: string, created: string, name: string, preview: string }} SessionInfo */

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 8 * 1024;
const READ_CONCURRENCY = 8;

export function agentDir(env = process.env) {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Same directory naming Pi uses for sessions: --C--path-to-project-- */
export function sessionDirFor(cwd, env = process.env) {
	const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir(env), "sessions", safe);
}

async function readChunk(path, start, length) {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** @param {PiContent | undefined} content */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts = /** @type {PiTextBlock[]} */ (content.filter((block) => block?.type === "text"));
	return texts.map((block) => block.text).join("\n");
}

/**
 * @param {string} text
 * @param {{ skipPartialFirst?: boolean }} [options]
 * @returns {PiSessionLine[]}
 */
function parseLines(text, { skipPartialFirst = false } = {}) {
	let body = text;
	if (skipPartialFirst) {
		const firstBreak = body.indexOf("\n");
		body = firstBreak === -1 ? "" : body.slice(firstBreak + 1);
	}
	const records = [];
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			/* truncated or unknown record */
		}
	}
	return records;
}

/**
 * @param {PiSessionLine[]} records
 * @param {SessionInfo} info
 */
function summarize(records, info) {
	for (const record of records) {
		if (record.type === "session") {
			info.id ||= record.id;
			info.cwd ||= record.cwd;
			info.created ||= record.timestamp;
			continue;
		}
		if (record.type === "session_info" && record.name) info.name = record.name;
		if (!info.preview && record.type === "message" && record.message?.role === "user") {
			info.preview = textOf(record.message.content)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160);
		}
	}
}

/**
 * Read the parts of a session file needed for the history list with a single
 * handle. Reading many files two times each made opening history unnecessarily
 * I/O heavy.
 */
async function readRecordChunks(path, size) {
	const handle = await open(path, "r");
	try {
		const records = [];
		const headLength = Math.min(size, HEAD_BYTES);
		if (headLength > 0) {
			const head = Buffer.alloc(headLength);
			const { bytesRead } = await handle.read(head, 0, headLength, 0);
			records.push(...parseLines(head.subarray(0, bytesRead).toString("utf8")));
		}
		if (size > HEAD_BYTES) {
			const tailLength = Math.min(size, TAIL_BYTES);
			const tail = Buffer.alloc(tailLength);
			const { bytesRead } = await handle.read(tail, 0, tailLength, size - tailLength);
			records.push(
				...parseLines(tail.subarray(0, bytesRead).toString("utf8"), {
					skipPartialFirst: true,
				}),
			);
		}
		return records;
	} finally {
		await handle.close();
	}
}

/** Run async work over many files without opening all of them at once. */
async function mapLimit(items, limit, mapper) {
	const results = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * List regular .jsonl files directly under the current project's Pi session
 * directory. Symlinks are ignored so a delete request can never escape it.
 */
async function sessionFiles(cwd, env) {
	const dir = sessionDirFor(cwd, env);
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return { dir, files: [] };
	}

	const files = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		try {
			const stats = await lstat(path);
			if (!stats.isFile() || stats.isSymbolicLink()) continue;
			files.push({ path, size: stats.size, modified: stats.mtimeMs });
		} catch {
			/* ignore vanished file */
		}
	}
	files.sort((a, b) => b.modified - a.modified);
	return { dir, files };
}

/** Read-only session listing. Never creates directories or files. */
export async function listSessions({ cwd, currentId, env = process.env }) {
	const { files } = await sessionFiles(cwd, env);

	const sessions = await mapLimit(files, READ_CONCURRENCY, async (candidate) => {
		const info = { id: "", cwd: "", created: "", name: "", preview: "" };
		try {
			summarize(await readRecordChunks(candidate.path, candidate.size), info);
		} catch {
			return null;
		}
		return {
			path: candidate.path,
			id: info.id,
			name: info.name,
			preview: info.preview,
			created: info.created,
			modified: new Date(candidate.modified).toISOString(),
			size: candidate.size,
			current: Boolean(currentId) && info.id === currentId,
		};
	});

	return sessions.filter(Boolean);
}

async function readSessionId(path, size) {
	try {
		const head = await readChunk(path, 0, Math.min(size, HEAD_BYTES));
		for (const record of parseLines(head)) {
			if (record.type === "session" && typeof record.id === "string" && record.id) {
				return record.id;
			}
		}
	} catch {
		/* unreadable file */
	}
	return "";
}

/**
 * Resolve the current project's session files by ID. IDs come from the
 * browser; paths never do. Re-enumerating here also keeps "all" correct even
 * when the UI only displayed a subset of the history.
 */
export async function resolveSessionTargets({
	cwd,
	ids = null,
	all = false,
	env = process.env,
}) {
	const { files } = await sessionFiles(cwd, env);
	const wanted = ids ? new Set(ids.filter((id) => typeof id === "string" && id)) : null;
	const targets = [];
	const found = new Set();

	for (const file of files) {
		const id = await readSessionId(file.path, file.size);
		if (!id) continue;
		if (all || (wanted && wanted.has(id))) {
			targets.push({
				id,
				path: file.path,
				size: file.size,
				modified: new Date(file.modified).toISOString(),
			});
			found.add(id);
		}
	}

	return {
		targets,
		missing: wanted ? [...wanted].filter((id) => !found.has(id)) : [],
	};
}

/** Delete one .jsonl file, but only if it is directly inside this cwd's dir. */
export async function deleteSessionFile({ cwd, path, env = process.env }) {
	if (typeof path !== "string" || !path) throw new Error("パスが不正です");
	const dir = sessionDirFor(cwd, env);
	const realDir = await realpath(dir);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error("通常のセッションファイルではありません");
	}
	const realPath = await realpath(path);
	const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
	if (key(dirname(realPath)) !== key(realDir) || extname(realPath) !== ".jsonl") {
		throw new Error("セッションディレクトリ外のファイルは削除できません");
	}
	await unlink(realPath);
}
