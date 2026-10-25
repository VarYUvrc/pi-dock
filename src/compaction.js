import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DockError } from "./errors.js";
import { agentDir } from "./sessions.js";

/**
 * Pi owns compaction configuration. Dock only reads and writes Pi's global
 * settings so the UI can show the threshold as a percentage of the current
 * model's context window. Project settings and per-model overrides are left
 * entirely to Pi.
 *
 * Writes happen only on explicit user action, with an atomic rename. Do not
 * edit the same settings file from Pi and Dock at the same moment.
 */
const DEFAULT_RESERVE = 16_384;
const ASSUMED_CONTEXT_WINDOW = 1_000_000;

export function settingsPath(env = process.env) {
	return join(agentDir(env), "settings.json");
}

async function readSettings(path, { strict = false } = {}) {
	try {
		const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
		if (!text.trim()) return {};
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			if (strict) throw new DockError("server.invalidSettings");
			return {};
		}
		return value;
	} catch (error) {
		if (error instanceof DockError) throw error;
		if (error.code === "ENOENT") return {};
		if (strict) throw new DockError("server.readSettings", { message: error.message });
		return {};
	}
}

function safeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function describeCompaction({ env = process.env, model }) {
	const path = settingsPath(env);
	const settings = await readSettings(path);
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : {};
	const contextWindow = safeInteger(model?.contextWindow) ?? 0;
	const displayContextWindow = contextWindow || ASSUMED_CONTEXT_WINDOW;
	const configuredReserve = safeInteger(compaction.reserveTokens);
	const reserveTokens = configuredReserve ?? DEFAULT_RESERVE;
	const thresholdTokens = Math.max(0, displayContextWindow - reserveTokens);
	return {
		enabled: compaction.enabled !== false,
		settingsPath: path,
		reserveTokens,
		reserveSource: configuredReserve === null ? "pi-default" : "settings",
		contextWindow,
		displayContextWindow,
		contextWindowKnown: contextWindow > 0,
		thresholdTokens,
		thresholdPercent: (thresholdTokens / displayContextWindow) * 100,
	};
}

function pruneEmpty(settings) {
	const compaction = settings.compaction;
	if (!compaction || typeof compaction !== "object") return;
	if (Object.keys(compaction).length === 0) delete settings.compaction;
}

export async function setCompactionThreshold({ env = process.env, model, percent }) {
	const contextWindow = safeInteger(model?.contextWindow) ?? 0;
	if (!contextWindow) throw new DockError("server.contextUnknown");
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
		throw new DockError("server.percentRange");
	}

	const path = settingsPath(env);
	const settings = await readSettings(path, { strict: true });
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : {};
	compaction.reserveTokens = contextWindow - Math.round((contextWindow * percent) / 100);
	settings.compaction = compaction;
	await writeSettings(path, settings);
	return describeCompaction({ env, model });
}

export async function clearCompactionThreshold({ env = process.env, model }) {
	const path = settingsPath(env);
	const settings = await readSettings(path, { strict: true });
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : null;
	if (!compaction) return describeCompaction({ env, model });
	delete compaction.reserveTokens;
	pruneEmpty(settings);
	await writeSettings(path, settings);
	return describeCompaction({ env, model });
}

export async function setCompactionEnabled({ env = process.env, enabled }) {
	const path = settingsPath(env);
	const settings = await readSettings(path, { strict: true });
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : {};
	compaction.enabled = Boolean(enabled);
	settings.compaction = compaction;
	await writeSettings(path, settings);
	return { enabled: Boolean(enabled) };
}

async function writeSettings(path, settings) {
	pruneEmpty(settings);
	const body = `${JSON.stringify(settings, null, 2)}\n`;
	let current = null;
	try {
		current = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (current === body) return;
	let mode = 0o600;
	try {
		mode = (await stat(path)).mode & 0o777;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporaryPath, body, { encoding: "utf8", mode });
		if (process.platform !== "win32") await chmod(temporaryPath, mode);
		await rename(temporaryPath, path);
	} finally {
		await unlink(temporaryPath).catch(() => {});
	}
}
