export const PLAN_TOOL = "tiny_plan";
export const PLAN_STATE_ENTRY = "tiny_plan_state";

// Plans saved by the pre-rename Pi Dock build remain readable.
const LEGACY_PLAN_TOOL = "dock_plan";
const LEGACY_PLAN_STATE_ENTRY = "dock_plan_state";

/** @typedef {import("./pi-types.js").PiSessionEntry} PiSessionEntry */
/** @typedef {"pending" | "in_progress" | "done" | "cancelled"} PlanItemStatus */
/** @typedef {{ id: string, text: string, status: PlanItemStatus, notes?: string[] }} PlanItem */
/** @typedef {{ title: string, items: PlanItem[] }} Plan */
/** @typedef {{ title?: unknown, items?: unknown }} PlanDetails */

const STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);

/** @param {unknown} value @returns {string[]} */
function normalizeNotes(value) {
	if (!Array.isArray(value)) return [];
	const notes = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const note = raw.replace(/\s+/g, " ").trim();
		if (note) notes.push(note);
	}
	return notes;
}

/**
 * Normalise the `details` payload of a tiny_plan tool result.
 * Returns null when details is not a plan; a cleared plan is an empty item list.
 * @param {unknown} details
 * @returns {Plan | null}
 */
export function normalizePlan(details) {
	if (!details || typeof details !== "object") return null;
	const plan = /** @type {PlanDetails} */ (details);
	if (!Array.isArray(plan.items)) return null;
	const items = [];
	for (const item of plan.items) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.id !== "string" || typeof item.text !== "string") continue;
		const notes = normalizeNotes(item.notes);
		items.push({
			id: item.id,
			text: item.text,
			status: STATUSES.has(item.status) ? item.status : "pending",
			...(notes.length ? { notes } : {}),
		});
	}
	const title =
		typeof plan.title === "string" && plan.title.trim() ? plan.title.trim() : "";
	return { title, items };
}

/** @param {PiSessionEntry} entry */
function planFromEntry(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (
		entry.type === "custom" &&
		(entry.customType === PLAN_STATE_ENTRY || entry.customType === LEGACY_PLAN_STATE_ENTRY)
	) {
		return normalizePlan(entry.data);
	}
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (
		message?.role !== "toolResult" ||
		(message.toolName !== PLAN_TOOL && message.toolName !== LEGACY_PLAN_TOOL)
	) {
		return null;
	}
	return normalizePlan(message.details);
}

/**
 * Pick the newest plan from the active branch. get_entries also returns
 * abandoned branches, so walking from leafId is required.
 * @param {PiSessionEntry[]} entries
 * @param {string | null} [leafId]
 * @returns {Plan | null}
 */
export function planFromEntries(entries, leafId) {
	if (!Array.isArray(entries) || !entries.length) return null;
	const byId = new Map();
	for (const entry of entries) {
		if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
	}
	let current = typeof leafId === "string" ? leafId : entries[entries.length - 1]?.id;
	const branch = [];
	const seen = new Set();
	while (typeof current === "string" && byId.has(current) && !seen.has(current)) {
		const entry = byId.get(current);
		branch.push(entry);
		seen.add(current);
		current = entry.parentId ?? null;
	}
	// Newest plan on the active branch. Only the agent replaces or clears a
	// plan; a new user message leaves the previous plan visible.
	for (const entry of branch) {
		const plan = planFromEntry(entry);
		if (plan) return plan;
	}
	return null;
}
