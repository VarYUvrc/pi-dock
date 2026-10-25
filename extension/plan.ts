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
}

interface PlanDetails {
	title?: string;
	items: PlanItem[];
	nextId: number;
	note?: string;
	action: string;
	error?: string;
}

interface PlanState {
	title?: string;
	items: PlanItem[];
	nextId: number;
	note?: string;
}

const ItemParam = Type.Object({
	id: Type.Optional(Type.String({ description: "Existing stable item id (omit for a new item)" })),
	text: Type.Optional(Type.String({ description: "Item text" })),
	status: Type.Optional(StringEnum(STATUSES)),
});

const PlanParams = Type.Object({
	action: StringEnum(["set", "add", "update", "remove", "list", "clear", "note"] as const),
	title: Type.Optional(Type.String({ description: "Plan title (for set)" })),
	items: Type.Optional(
		Type.Array(ItemParam, {
			description: "Initial ordered plan (for set). Keep existing ids to preserve status.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Item text (for add/update)" })),
	id: Type.Optional(Type.String({ description: "Item id (for update/remove)" })),
	status: Type.Optional(StringEnum(STATUSES)),
	note: Type.Optional(
		Type.String({
			description:
				"One short progress sentence for the user, in their language. Shown in the main screen. Include with set/update at phase changes, or use action=note for a mid-step update.",
		}),
	),
});

const MARKS: Record<PlanStatus, string> = {
	done: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
	cancelled: "[-]",
};

function clonePlan(plan: PlanState): PlanState {
	return {
		...(plan.title ? { title: plan.title } : {}),
		...(plan.note ? { note: plan.note } : {}),
		items: plan.items.map((item) => ({ ...item })),
		nextId: plan.nextId,
	};
}

function normalizeNote(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const note = value.replace(/\s+/g, " ").trim();
	return note || undefined;
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
		note?: unknown;
	};
	if (!Array.isArray(value.items)) return null;
	const items: PlanItem[] = [];
	for (const raw of value.items) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as { id?: unknown; text?: unknown; status?: unknown };
		if (typeof item.id !== "string" || typeof item.text !== "string") continue;
		items.push({ id: item.id, text: item.text, status: validStatus(item.status) });
	}
	const plan: PlanState = {
		items,
		nextId: typeof value.nextId === "number" && value.nextId > 0 ? value.nextId : 1,
	};
	if (typeof value.title === "string" && value.title.trim()) plan.title = value.title.trim();
	const note = normalizeNote(value.note);
	if (note) plan.note = note;
	return plan;
}

export default function (pi: ExtensionAPI) {
	let plan: PlanState = { items: [], nextId: 1 };

	const reconstruct = (ctx: ExtensionContext) => {
		plan = { items: [], nextId: 1 };
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
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "tiny_plan",
		label: "Plan",
		description:
			"Track a multi-step implementation plan and the current focus. For any task that will need more than a few tool calls—including investigation, design, or debugging—call set with a short provisional plan before the first substantive tool call; include the steps you can foresee through final verification and refine the plan in place as you learn. Keep the current item granularity; do not split items into micro-steps. Then keep it current while working: when a step starts mark it in_progress, and as soon as it finishes mark it done and the next step in_progress. Never leave the first step in_progress during later work and never mark several steps done together at the end. Keep exactly one item in_progress. Include a one-sentence note in the user's language when you start or finish a step, and use action=note for a meaningful mid-step update; the note is shown in the main screen, so do not repeat the plan or narrate every tool call. Use update for one item, add only for a genuinely new step discovered later, remove to delete one, and clear when finished. Reuse item ids. Continue the same plan through follow-up or steering messages. When the previous work is complete and a new independent task begins, call set to replace the old plan. Do not clear the plan just because a new user message arrived.",
		promptSnippet: "Track a multi-step plan, progress and the current focus",
		promptGuidelines: [
			"Before the first substantive tool call for a multi-step task, including investigation or design, create a short provisional plan in one tiny_plan set call.",
			"Update tiny_plan immediately when a step starts or finishes; never batch completed steps into the final call.",
			"Include a one-sentence note in the user's language at phase changes; use action=note for a mid-step update and keep it brief.",
		],
		executionMode: "sequential",
		parameters: PlanParams,

		async execute(_toolCallId, params) {
			const snapshot = () => clonePlan(plan);
			const applyNote = (value: string | undefined) => {
				if (value === undefined) return;
				const note = normalizeNote(value);
				if (note) plan.note = note;
				else delete plan.note;
			};
			const fail = (message: string, action: string) => ({
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { ...snapshot(), action, error: message } as PlanDetails,
			});
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
						const current = raw.id ? existing.get(raw.id) : undefined;
						const text = raw.text ?? current?.text;
						if (!text || !text.trim()) return fail("Every item needs text", "set");
						const id = current ? current.id : `p${nextId++}`;
						if (seen.has(id)) return fail(`Duplicate item id: ${id}`, "set");
						seen.add(id);
						next.push({
							id,
							text: text.trim(),
							status: raw.status ?? current?.status ?? "pending",
						});
					}
					const note = normalizeNote(params.note);
					plan = {
						...(params.title?.trim() ? { title: params.title.trim() } : {}),
						...(note ? { note } : {}),
						items: next,
						nextId,
					};
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
					const item: PlanItem = {
						id: `p${plan.nextId++}`,
						text: params.text.trim(),
						status: params.status ?? "pending",
					};
					plan.items.push(item);
					applyNote(params.note);
					return result("add", `Added ${item.id}: ${item.text}\n${formatPlan(plan)}`);
				}

				case "update": {
					if (!params.id) return fail("id required for update", "update");
					const item = plan.items.find((candidate) => candidate.id === params.id);
					if (!item) return fail(`Item ${params.id} not found`, "update");
					if (params.text?.trim()) item.text = params.text.trim();
					if (params.status) item.status = params.status;
					applyNote(params.note);
					return result("update", formatPlan(plan));
				}

				case "remove": {
					if (!params.id) return fail("id required for remove", "remove");
					const index = plan.items.findIndex((candidate) => candidate.id === params.id);
					if (index === -1) return fail(`Item ${params.id} not found`, "remove");
					plan.items.splice(index, 1);
					applyNote(params.note);
					return result("remove", formatPlan(plan));
				}

				case "clear": {
					plan = { items: [], nextId: 1 };
					return result("clear", "Plan cleared");
				}

				case "note": {
					const note = normalizeNote(params.note);
					if (!note) return fail("note required for note", "note");
					plan.note = note;
					return result("note", `Note: ${note}`);
				}

				case "list":
					return result("list", formatPlan(plan));

				default:
					return fail(`Unknown action: ${params.action}`, "list");
			}
		},
	});
}
