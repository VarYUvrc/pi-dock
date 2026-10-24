import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 8 * 1024;
const MAX_SESSIONS = 60;

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

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

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

/** Read-only session listing. Never creates directories or files. */
export async function listSessions({ cwd, currentId, env = process.env }) {
	const dir = sessionDirFor(cwd, env);
	let files;
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}

	const candidates = [];
	for (const name of files) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(dir, name);
		try {
			const stats = await stat(path);
			if (!stats.isFile()) continue;
			candidates.push({ path, size: stats.size, modified: stats.mtimeMs });
		} catch {
			/* ignore vanished file */
		}
	}
	candidates.sort((a, b) => b.modified - a.modified);

	const sessions = await Promise.all(
		candidates.slice(0, MAX_SESSIONS).map(async (candidate) => {
			const info = { id: "", cwd: "", created: "", name: "", preview: "" };
			try {
				const head = await readChunk(
					candidate.path,
					0,
					Math.min(candidate.size, HEAD_BYTES),
				);
				summarize(parseLines(head), info);
				if (candidate.size > HEAD_BYTES) {
					const tail = await readChunk(
						candidate.path,
						Math.max(0, candidate.size - TAIL_BYTES),
						TAIL_BYTES,
					);
					summarize(parseLines(tail, { skipPartialFirst: true }), info);
				}
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
		}),
	);

	return sessions.filter(Boolean);
}
