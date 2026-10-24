export const PLAN_TOOL = "dock_plan";
export const PLAN_STATE_ENTRY = "dock_plan_state";

/** @typedef {import("./pi-protocol.js").PiSessionEntry} PiSessionEntry */
/** @typedef {"pending" | "in_progress" | "done" | "cancelled"} PlanItemStatus */
/** @typedef {{ id: string, text: string, status: PlanItemStatus }} PlanItem */
/** @typedef {{ title: string, items: PlanItem[] }} Plan */
/** @typedef {{ title?: unknown, items?: unknown }} PlanDetails */

const STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);

/**
 * Normalise the `details` payload of a dock_plan tool result.
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
		items.push({
			id: item.id,
			text: item.text,
			status: STATUSES.has(item.status) ? item.status : "pending",
		});
	}
	const title =
		typeof plan.title === "string" && plan.title.trim() ? plan.title.trim() : "";
	return { title, items };
}

/** @param {PiSessionEntry} entry */
function planFromEntry(entry) {
	if (!entry || typeof entry !== "object") return null;
	if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY) {
		return normalizePlan(entry.data);
	}
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message?.role !== "toolResult" || message.toolName !== PLAN_TOOL) return null;
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
	for (const [index, entry] of branch.entries()) {
		const plan = planFromEntry(entry);
		if (!plan) continue;
		// A completed plan belongs to the turn that completed it. Once a newer
		// user message arrives, keep it in Pi's history but leave the right
		// panel empty until the agent updates or replaces the plan.
		const complete =
			plan.items.length > 0 &&
			plan.items.every((item) => item.status === "done" || item.status === "cancelled");
		const newerUserMessage = branch
			.slice(0, index)
			.some(
				(candidate) =>
					candidate.type === "message" && candidate.message?.role === "user",
			);
		if (complete && newerUserMessage) return null;
		return plan;
	}
	return null;
}
