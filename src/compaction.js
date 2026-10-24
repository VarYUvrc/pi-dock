import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentDir } from "./sessions.js";

/**
 * Pi owns compaction configuration. Dock only reads the same settings file so
 * the context ring can show where automatic compaction will start, and writes
 * back to it when the user explicitly picks a threshold in the UI.
 */
const DEFAULT_RESERVE = 16_384;
const DEFAULT_KEEP_RECENT = 20_000;

export function settingsPath(env = process.env) {
	return join(agentDir(env), "settings.json");
}

function projectSettingsPath(cwd) {
	return cwd ? join(cwd, ".pi", "settings.json") : null;
}

async function readSettings(path, { strict = false } = {}) {
	if (!path) return {};
	try {
		const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
		if (!text.trim()) return {};
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			if (strict) throw new Error(`${path} の形式が不正です`);
			return {};
		}
		return value;
	} catch (error) {
		if (error.code === "ENOENT") return {};
		if (strict) {
			throw new Error(`設定を読み込めません: ${error.message}`);
		}
		return {};
	}
}

function mergeCompaction(user, project) {
	const base = user?.compaction && typeof user.compaction === "object" ? user.compaction : {};
	const override =
		project?.compaction && typeof project.compaction === "object" ? project.compaction : {};
	const modelOverrides = { ...(base.modelOverrides ?? {}) };
	for (const [key, value] of Object.entries(override.modelOverrides ?? {})) {
		if (!value || typeof value !== "object") continue;
		const current = modelOverrides[key];
		modelOverrides[key] =
			current && typeof current === "object" ? { ...current, ...value } : { ...value };
	}
	return {
		...(base.enabled !== undefined || override.enabled !== undefined
			? { enabled: override.enabled ?? base.enabled }
			: {}),
		...(base.reserveTokens !== undefined || override.reserveTokens !== undefined
			? { reserveTokens: override.reserveTokens ?? base.reserveTokens }
			: {}),
		...(base.keepRecentTokens !== undefined || override.keepRecentTokens !== undefined
			? { keepRecentTokens: override.keepRecentTokens ?? base.keepRecentTokens }
			: {}),
		...(Object.keys(modelOverrides).length ? { modelOverrides } : {}),
	};
}

function modelKey(model) {
	if (!model?.provider || !model?.id) return null;
	return `${model.provider}/${model.id}`;
}

function safeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function describeCompaction({ cwd, env = process.env, model }) {
	const path = settingsPath(env);
	const projectPath = projectSettingsPath(cwd);
	const user = await readSettings(path);
	const project = await readSettings(projectPath);
	const compaction = mergeCompaction(user, project);
	const key = modelKey(model);
	const perModel =
		key && compaction.modelOverrides?.[key] && typeof compaction.modelOverrides[key] === "object"
			? compaction.modelOverrides[key]
			: null;
	const projectCompaction =
		project?.compaction && typeof project.compaction === "object" ? project.compaction : null;
	const projectModel =
		key &&
		projectCompaction?.modelOverrides?.[key] &&
		typeof projectCompaction.modelOverrides[key] === "object"
			? projectCompaction.modelOverrides[key]
			: null;
	const projectReserve = safeInteger(
		projectModel?.reserveTokens ?? projectCompaction?.reserveTokens,
	);
	const reserveTokens =
		safeInteger(perModel?.reserveTokens) ??
		safeInteger(compaction.reserveTokens) ??
		DEFAULT_RESERVE;
	const keepRecentTokens =
		safeInteger(perModel?.keepRecentTokens) ??
		safeInteger(compaction.keepRecentTokens) ??
		DEFAULT_KEEP_RECENT;
	const contextWindow = safeInteger(model?.contextWindow) ?? 0;
	const thresholdTokens = contextWindow ? Math.max(0, contextWindow - reserveTokens) : null;
	return {
		enabled: compaction.enabled !== false,
		settingsPath: path,
		projectSettingsPath: projectPath,
		projectOverridesReserve: projectReserve !== null,
		modelKey: key,
		reserveTokens,
		keepRecentTokens,
		thresholdTokens,
		thresholdPercent:
			contextWindow && thresholdTokens !== null ? (thresholdTokens / contextWindow) * 100 : null,
		contextWindow,
		reserveSource:
			perModel?.reserveTokens !== undefined
				? projectModel?.reserveTokens !== undefined
					? "project-model"
					: "model"
				: projectCompaction?.reserveTokens !== undefined
					? "project"
					: "default",
		modelOverride: perModel ? { ...perModel } : null,
	};
}

function pruneEmpty(settings) {
	const compaction = settings.compaction;
	if (!compaction || typeof compaction !== "object") return;
	if (compaction.modelOverrides && typeof compaction.modelOverrides === "object") {
		for (const [key, value] of Object.entries(compaction.modelOverrides)) {
			if (!value || typeof value !== "object" || Object.keys(value).length === 0) {
				delete compaction.modelOverrides[key];
			}
		}
		if (Object.keys(compaction.modelOverrides).length === 0) delete compaction.modelOverrides;
	}
	if (Object.keys(compaction).length === 0) delete settings.compaction;
}

/**
 * Explicit user action only: set this model's automatic-compaction threshold.
 * `percent` is the context usage at which compaction should start; the Pi
 * setting itself is the inverse reserve. Pass `null` to remove the override.
 */
export async function setCompactionThreshold({ cwd, env = process.env, model, percent }) {
	const key = modelKey(model);
	if (!key) throw new Error("モデルが選択されていません");
	const contextWindow = safeInteger(model?.contextWindow) ?? 0;
	if (!contextWindow) throw new Error("このモデルのコンテキスト長が不明です");
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
		throw new Error("圧縮しきい値は 1〜99% で指定してください");
	}

	const path = settingsPath(env);
	const settings = await readSettings(path, { strict: true });
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : {};
	const modelOverrides =
		compaction.modelOverrides && typeof compaction.modelOverrides === "object"
			? compaction.modelOverrides
			: {};
	const current =
		modelOverrides[key] && typeof modelOverrides[key] === "object" ? modelOverrides[key] : {};
	const reserveTokens = contextWindow - Math.round((contextWindow * percent) / 100);
	const next = { ...current, reserveTokens };
	modelOverrides[key] = next;
	compaction.modelOverrides = modelOverrides;
	settings.compaction = compaction;
	await writeSettings(path, settings);
	return describeCompaction({ cwd, env, model });
}

export async function clearCompactionThreshold({ cwd, env = process.env, model }) {
	const key = modelKey(model);
	if (!key) throw new Error("モデルが選択されていません");
	const path = settingsPath(env);
	const settings = await readSettings(path, { strict: true });
	const compaction =
		settings.compaction && typeof settings.compaction === "object" ? settings.compaction : null;
	if (!compaction) return describeCompaction({ cwd, env, model });
	const modelOverrides =
		compaction.modelOverrides && typeof compaction.modelOverrides === "object"
			? compaction.modelOverrides
			: null;
	if (modelOverrides?.[key] && typeof modelOverrides[key] === "object") {
		const entries = { ...modelOverrides[key] };
		delete entries.reserveTokens;
		if (Object.keys(entries).length) modelOverrides[key] = entries;
		else delete modelOverrides[key];
	}
	pruneEmpty(settings);
	await writeSettings(path, settings);
	return describeCompaction({ cwd, env, model });
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
