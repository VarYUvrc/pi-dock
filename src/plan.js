export const PLAN_TOOL = "dock_plan";

const STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);

/**
 * Normalise the `details` payload of a dock_plan tool result.
 * Returns null when details is not a plan; a cleared plan is an empty item list.
 */
export function normalizePlan(details) {
	if (!details || typeof details !== "object") return null;
	if (!Array.isArray(details.items)) return null;
	const items = [];
	for (const item of details.items) {
		if (!item || typeof item !== "object") continue;
		if (typeof item.id !== "string" || typeof item.text !== "string") continue;
		items.push({
			id: item.id,
			text: item.text,
			status: STATUSES.has(item.status) ? item.status : "pending",
		});
	}
	const title =
		typeof details.title === "string" && details.title.trim() ? details.title.trim() : "";
	return { title, items };
}

/**
 * Pick the newest plan from the active branch. get_entries also returns
 * abandoned branches, so walking from leafId is required.
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
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "toolResult" || message.toolName !== PLAN_TOOL) continue;
		const plan = normalizePlan(message.details);
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
