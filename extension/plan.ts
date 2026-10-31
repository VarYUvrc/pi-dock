/**
 * Plan - minimal implementation plan tool for Pi TinyChat.
 *
 * The plan is stored in Pi's session JSONL twice: a custom entry is appended
 * after every successful mutation so the Web UI can update immediately, and
 * the tool result `details` keeps the plan readable by older sessions. When
 * the branch changes, state is rebuilt from the active branch.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATUSES = ["pending", "in_progress", "done", "cancelled"] as const;
type PlanStatus = (typeof STATUSES)[number];

const PLAN_STATE_ENTRY = "tiny_plan_state";
const LEGACY_PLAN_STATE_ENTRY = "dock_plan_state";
const LEGACY_PLAN_TOOL = "dock_plan";

interface PlanItem {
	id: string;
	text: string;
	status: PlanStatus;
	notes?: string[];
}

interface PlanDetails {
	title?: string;
	items: PlanItem[];
	nextId: number;
	action: string;
	error?: string;
}

interface PlanState {
	title?: string;
	items: PlanItem[];
	nextId: number;
}

const ItemParam = Type.Object({
	id: Type.Optional(Type.String({ description: "Existing stable item id (omit for a new item)" })),
	text: Type.Optional(Type.String({ description: "Item text" })),
	status: Type.Optional(StringEnum(STATUSES)),
});

const PlanParams = Type.Object({
	action: StringEnum([
		"set",
		"add",
		"update",
		"remove",
		"advance",
		"list",
		"clear",
		"note",
	] as const),
	title: Type.Optional(Type.String({ description: "Plan title (for set)" })),
	items: Type.Optional(
		Type.Array(ItemParam, {
			description: "Initial ordered plan (for set). Keep existing ids to preserve status.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Item text (for add/update)" })),
	id: Type.Optional(Type.String({ description: "Item id (for update/remove/advance)" })),
	status: Type.Optional(StringEnum(STATUSES)),
	note: Type.Optional(
		Type.String({
			description:
				"One short progress sentence for the user, in their language. Appended under the step that is in progress in the plan panel. Include with set/update at phase changes, or use action=note for a mid-step update.",
		}),
	),
});

const MARKS: Record<PlanStatus, string> = {
	done: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
	cancelled: "[-]",
};

// A stale plan is worse than no plan. Nudge the model from a tool result
// instead of spending a model turn, and only once per phase.
const STALE_TOOL_CALLS = 6;
const MUTATING_TOOL_CALLS = 3;

function cloneItem(item: PlanItem): PlanItem {
	return {
		...item,
		...(item.notes?.length ? { notes: [...item.notes] } : {}),
	};
}

function clonePlan(plan: PlanState): PlanState {
	return {
		...(plan.title ? { title: plan.title } : {}),
		items: plan.items.map(cloneItem),
		nextId: plan.nextId,
	};
}

function normalizeNote(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const note = value.replace(/\s+/g, " ").trim();
	return note || undefined;
}

function normalizeNotes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const notes: string[] = [];
	for (const raw of value) {
		const note = normalizeNote(raw);
		if (note) notes.push(note);
	}
	return notes;
}

/** Notes belong to a step: the active one, else the last one. */
function noteTarget(items: PlanItem[]): PlanItem | undefined {
	return items.find((item) => item.status === "in_progress") ?? items[items.length - 1];
}

/** Notes are append-only; once recorded they stay under the same step. */
function appendNote(target: PlanItem | undefined, value: unknown) {
	const note = normalizeNote(value);
	if (!target || !note) return;
	const notes = target.notes ?? [];
	if (notes[notes.length - 1] === note) return;
	target.notes = [...notes, note];
}

function clip(text: string, max = 60): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keep auto ids clear of ids the model supplied explicitly. */
function bumpNextId(items: PlanItem[], start: number): number {
	let nextId = start;
	const used = new Set(items.map((item) => item.id));
	while (used.has(`p${nextId}`)) nextId++;
	return nextId;
}

function allocateId(items: PlanItem[], start: number): { id: string; nextId: number } {
	const nextId = bumpNextId(items, start);
	return { id: `p${nextId}`, nextId: nextId + 1 };
}

function formatPlan(plan: PlanState): string {
	const lines = plan.title ? [plan.title] : [];
	for (const item of plan.items) {
		lines.push(`${MARKS[item.status]} ${item.id}: ${item.text}`);
	}
	if (!lines.length) return "No plan";
	if (!plan.items.length) lines.push("No items");
	return lines.join("\n");
}

function validStatus(value: unknown): PlanStatus {
	return STATUSES.includes(value as PlanStatus) ? (value as PlanStatus) : "pending";
}

function planFromDetails(details: unknown): PlanState | null {
	if (!details || typeof details !== "object") return null;
	const value = details as {
		title?: unknown;
		items?: unknown;
		nextId?: unknown;
	};
	if (!Array.isArray(value.items)) return null;
	const items: PlanItem[] = [];
	for (const raw of value.items) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as { id?: unknown; text?: unknown; status?: unknown; notes?: unknown };
		if (typeof item.id !== "string" || typeof item.text !== "string") continue;
		const notes = normalizeNotes(item.notes);
		items.push({
			id: item.id,
			text: item.text,
			status: validStatus(item.status),
			...(notes.length ? { notes } : {}),
		});
	}
	const plan: PlanState = {
		items,
		nextId: typeof value.nextId === "number" && value.nextId > 0 ? value.nextId : 1,
	};
	if (typeof value.title === "string" && value.title.trim()) plan.title = value.title.trim();
	return plan;
}

export default function (pi: ExtensionAPI) {
	let plan: PlanState = { items: [], nextId: 1 };
	let toolsSincePlan = 0;
	let nudged = false;
	let mutationNudged = false;
	let mutatedSincePlan = false;

	const touchPlan = (resetMutation = false) => {
		toolsSincePlan = 0;
		nudged = false;
		mutationNudged = false;
		if (resetMutation) mutatedSincePlan = false;
	};

	const reconstruct = (ctx: ExtensionContext) => {
		plan = { items: [], nextId: 1 };
		touchPlan(true);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				(entry.customType === PLAN_STATE_ENTRY || entry.customType === LEGACY_PLAN_STATE_ENTRY)
			) {
				const restored = planFromDetails(entry.data);
				if (restored) plan = restored;
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (
				message.role !== "toolResult" ||
				(message.toolName !== "tiny_plan" && message.toolName !== LEGACY_PLAN_TOOL)
			) {
				continue;
			}
			const restored = planFromDetails(message.details);
			if (restored) plan = restored;
		}
		touchPlan(true);
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "tiny_plan",
		label: "Plan",
		description:
			"Track a multi-step implementation plan and the current focus. For any task that will need more than a few tool calls—including investigation, design, or debugging—call set with a short provisional plan before the first substantive tool call; include the steps you can foresee through final verification and refine the plan in place as you learn. Keep the current item granularity; do not split items into micro-steps. Then keep it current while working: when a step starts mark it in_progress, and as soon as it finishes mark it done and the next step in_progress. Use action=advance to finish the in-progress step and start the next pending step in one call. Never leave the first step in_progress during later work and never mark several steps done together at the end. Keep exactly one item in_progress. Include a one-sentence note in the user's language when you start or finish a step, and use action=note for a meaningful mid-step update; the note is appended under that step in the plan panel and stays there, so do not repeat the plan or narrate every tool call. Use update for one item, add only for a genuinely new step discovered later, remove to delete one, and clear when finished. Reuse item ids so earlier notes stay attached. Continue the same plan through follow-up or steering messages. When the previous work is complete and a new independent task begins, call set to replace the old plan. Do not clear the plan just because a new user message arrived.",
		promptSnippet: "Track a multi-step plan, progress and the current focus",
		promptGuidelines: [
			"Before the first substantive tool call for a multi-step task, including investigation or design, create a short provisional plan in one tiny_plan set call.",
			"Update tiny_plan immediately when a step starts or finishes; prefer one action=advance call at a phase boundary and never batch completed steps into the final call.",
			"Include a one-sentence note in the user's language at phase changes; use action=note for a mid-step update and keep it brief.",
		],
		executionMode: "sequential",
		parameters: PlanParams,

		async execute(_toolCallId, params) {
			const snapshot = () => clonePlan(plan);
			const fail = (message: string, action: string) => {
				const current = plan.items.length ? `\n${formatPlan(plan)}` : "";
				return {
					content: [{ type: "text" as const, text: `Error: ${message}${current}` }],
					details: { ...snapshot(), action, error: message } as PlanDetails,
				};
			};
			const result = (action: string, text: string) => {
				if (action !== "list") pi.appendEntry(PLAN_STATE_ENTRY, clonePlan(plan));
				return {
					content: [{ type: "text" as const, text }],
					details: { ...snapshot(), action } as PlanDetails,
				};
			};

			switch (params.action) {
				case "set": {
					const incoming = params.items ?? [];
					const existing = new Map(plan.items.map((item) => [item.id, item]));
					const next: PlanItem[] = [];
					let nextId = plan.nextId;
					const seen = new Set<string>();
					for (const raw of incoming) {
						const requestedId = raw.id?.trim();
						const current = requestedId ? existing.get(requestedId) : undefined;
						const text = raw.text ?? current?.text;
						if (!text || !text.trim()) return fail("Every item needs text", "set");
						const id = requestedId || `p${nextId++}`;
						if (seen.has(id)) return fail(`Duplicate item id: ${id}`, "set");
						seen.add(id);
						next.push({
							id,
							text: text.trim(),
							status: raw.status ?? current?.status ?? "pending",
							...(current?.notes?.length ? { notes: [...current.notes] } : {}),
						});
					}
					nextId = bumpNextId(next, nextId);
					plan = {
						...(params.title?.trim() ? { title: params.title.trim() } : {}),
						items: next,
						nextId,
					};
					appendNote(noteTarget(plan.items), params.note);
					touchPlan(true);
					return result("set", formatPlan(plan));
				}

				case "add": {
					if (!plan.items.length) {
						return fail(
							"Create the plan first with action=set, then use add only for a new step",
							"add",
						);
					}
					if (!params.text?.trim()) return fail("text required for add", "add");
					const allocated = allocateId(plan.items, plan.nextId);
					const item: PlanItem = {
						id: allocated.id,
						text: params.text.trim(),
						status: params.status ?? "pending",
					};
					plan.nextId = allocated.nextId;
					plan.items.push(item);
					appendNote(noteTarget(plan.items), params.note);
					touchPlan();
					return result("add", `Added ${item.id}: ${item.text}\n${formatPlan(plan)}`);
				}

				case "update": {
					if (!params.id) return fail("id required for update", "update");
					const item = plan.items.find((candidate) => candidate.id === params.id);
					if (!item) return fail(`Item ${params.id} not found`, "update");
					const statusChanged = Boolean(params.status && params.status !== item.status);
					if (params.text?.trim()) item.text = params.text.trim();
					if (params.status) item.status = params.status;
					appendNote(item, params.note);
					touchPlan(statusChanged);
					return result("update", formatPlan(plan));
				}

				case "advance": {
					if (!plan.items.length) {
						return fail("Create the plan first with action=set", "advance");
					}
					const active = plan.items.find((item) => item.status === "in_progress");
					const target = params.id
						? plan.items.find((item) => item.id === params.id)
						: active ?? plan.items.find((item) => item.status === "pending");
					if (!target) return fail("No in-progress or pending item to advance", "advance");
					if (target.status === "pending" && active && active !== target) {
						return fail(`Item ${active.id} is still in progress`, "advance");
					}
					if (target.status === "done" || target.status === "cancelled") {
						return fail(`Item ${target.id} is already ${target.status}`, "advance");
					}
					if (target.status === "pending") {
						target.status = "in_progress";
						appendNote(target, params.note);
						touchPlan(true);
						return result("advance", `Started ${target.id}: ${target.text}\n${formatPlan(plan)}`);
					}
					target.status = "done";
					appendNote(target, params.note);
					const index = plan.items.indexOf(target);
					const next =
						plan.items.slice(index + 1).find((item) => item.status === "pending") ??
						plan.items.find((item) => item.status === "pending");
					if (next) next.status = "in_progress";
					touchPlan(true);
					return result(
						"advance",
						`Finished ${target.id}${next ? `; ${next.id} in progress` : "; plan complete"}\n${formatPlan(plan)}`,
					);
				}

				case "remove": {
					if (!params.id) return fail("id required for remove", "remove");
					const index = plan.items.findIndex((candidate) => candidate.id === params.id);
					if (index === -1) return fail(`Item ${params.id} not found`, "remove");
					plan.items.splice(index, 1);
					appendNote(noteTarget(plan.items), params.note);
					touchPlan(true);
					return result("remove", formatPlan(plan));
				}

				case "clear": {
					plan = { items: [], nextId: 1 };
					touchPlan(true);
					return result("clear", "Plan cleared");
				}

				case "note": {
					const note = normalizeNote(params.note);
					if (!note) return fail("note required for note", "note");
					const target = noteTarget(plan.items);
					if (!target) return fail("Create the plan first with action=set, then add notes", "note");
					appendNote(target, note);
					touchPlan();
					return result("note", `Note: ${note}`);
				}

				case "list":
					return result("list", formatPlan(plan));

				default:
					return fail(`Unknown action: ${params.action}`, "list");
			}
		},
	});

	// Keep the plan current without adding a model turn. The nudge lands in the
	// next tool result the model reads, and fires at most once per phase.
	pi.on("tool_result", async (event) => {
		if (event.toolName === "tiny_plan" || event.parentToolCallId || event.isError) return;
		toolsSincePlan++;
		const mutating = event.toolName === "edit" || event.toolName === "write";
		const firstMutation = mutating && !mutatedSincePlan;
		if (mutating) mutatedSincePlan = true;
		const target =
			plan.items.find((item) => item.status === "in_progress") ??
			plan.items.find((item) => item.status === "pending");
		if (!target) return;
		const mutationNudge =
			firstMutation && !mutationNudged && toolsSincePlan >= MUTATING_TOOL_CALLS;
		const staleNudge = !nudged && toolsSincePlan >= STALE_TOOL_CALLS;
		if (!mutationNudge && !staleNudge) return;
		if (mutationNudge) mutationNudged = true;
		nudged = true;
		const state = target.status === "in_progress" ? "in progress" : "pending";
		const text = `[plan] ${target.id} "${clip(target.text)}" is still ${state} after ${toolsSincePlan} tool calls. If done: action=advance; else: action=note.`;
		return {
			content: [...event.content, { type: "text", text }],
		};
	});
}
