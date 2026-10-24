/**
 * Dock Plan - minimal implementation plan tool for Pi Dock.
 *
 * The plan lives in the tool result `details`, so Pi's session JSONL is the
 * only storage. Branching is handled by rebuilding state from the active
 * branch, exactly like the official todo example.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATUSES = ["pending", "in_progress", "done", "cancelled"] as const;
type PlanStatus = (typeof STATUSES)[number];

const PLAN_STATE_ENTRY = "dock_plan_state";
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

interface PlanItem {
	id: string;
	text: string;
	status: PlanStatus;
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
	action: StringEnum(["set", "add", "update", "remove", "list", "clear"] as const),
	title: Type.Optional(Type.String({ description: "Plan title (for set)" })),
	items: Type.Optional(
		Type.Array(ItemParam, {
			description: "Complete ordered plan (for set). Keep existing ids to preserve status.",
		}),
	),
	text: Type.Optional(Type.String({ description: "Item text (for add/update)" })),
	id: Type.Optional(Type.String({ description: "Item id (for update/remove)" })),
	status: Type.Optional(StringEnum(STATUSES)),
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
		items: plan.items.map((item) => ({ ...item })),
		nextId: plan.nextId,
	};
}

/** Move a single step forward when the model forgot to update the plan. */
function advancePlan(plan: PlanState): PlanState | null {
	const active = plan.items.findIndex((item) => item.status === "in_progress");
	if (active === -1) return null;
	const next = plan.items.findIndex(
		(item, index) => index > active && item.status === "pending",
	);
	// Leave the final step to the model so completion stays explicit.
	if (next === -1) return null;
	const items = plan.items.map((item) => ({ ...item }));
	items[active].status = "done";
	items[next].status = "in_progress";
	return {
		...(plan.title ? { title: plan.title } : {}),
		items,
		nextId: plan.nextId,
	};
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
	const value = details as { title?: unknown; items?: unknown; nextId?: unknown };
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
	return plan;
}

export default function (pi: ExtensionAPI) {
	let plan: PlanState = { items: [], nextId: 1 };
	let planTouchedThisTurn = false;

	const reconstruct = (ctx: ExtensionContext) => {
		plan = { items: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY) {
				const restored = planFromDetails(entry.data);
				if (restored) plan = restored;
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "dock_plan") continue;
			const restored = planFromDetails(message.details);
			if (restored) plan = restored;
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("turn_start", () => {
		planTouchedThisTurn = false;
	});

	// Models often leave the first step in_progress while doing later work and
	// mark everything done at the end. Advance one step per turn that changed
	// files or ran a command and did not touch the plan, so the panel fills
	// gradually without advancing on read-only follow-up questions.
	pi.on("turn_end", (event) => {
		const touched = planTouchedThisTurn;
		planTouchedThisTurn = false;
		if (touched) return;
		const worked = event.toolResults.some(
			(result) => MUTATING_TOOLS.has(result.toolName) && !result.isError,
		);
		if (!worked) return;
		const next = advancePlan(plan);
		if (!next) return;
		plan = next;
		pi.appendEntry(PLAN_STATE_ENTRY, clonePlan(plan));
	});

	pi.registerTool({
		name: "dock_plan",
		label: "Plan",
		description:
			"Track a multi-step implementation plan. For any task with several distinct steps, call set with the COMPLETE ordered plan in one call before editing files or running commands; include every step through final verification, not only the first step. Then keep it current while working: when a step starts mark it in_progress, and as soon as it finishes mark it done and the next step in_progress. Never leave the first step in_progress during later work and never mark several steps done together at the end. Keep exactly one item in_progress. Use update for one item, add only for a genuinely new step discovered later, remove to delete one, and clear when finished. Reuse item ids. Continue the same plan through follow-up or steering messages. When the previous work is complete and a new independent task begins, call set to replace the old plan. Do not clear the plan just because a new user message arrived.",
		promptSnippet: "Track a multi-step plan and its progress",
		promptGuidelines: [
			"Before editing files for a multi-step task, create the complete ordered plan in one dock_plan set call.",
			"Update dock_plan immediately when a step starts or finishes; never batch completed steps into the final call.",
		],
		executionMode: "sequential",
		parameters: PlanParams,

		async execute(_toolCallId, params) {
			planTouchedThisTurn = true;
			const snapshot = () => clonePlan(plan);
			const fail = (message: string, action: string) => ({
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { ...snapshot(), action, error: message } as PlanDetails,
			});
			const result = (action: string, text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { ...snapshot(), action } as PlanDetails,
			});

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
					plan = {
						...(params.title?.trim() ? { title: params.title.trim() } : {}),
						items: next,
						nextId,
					};
					return result("set", formatPlan(plan));
				}

				case "add": {
					if (!plan.items.length) {
						return fail(
							"Create the complete plan first with action=set, then use add only for a new step",
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
					return result("add", `Added ${item.id}: ${item.text}\n${formatPlan(plan)}`);
				}

				case "update": {
					if (!params.id) return fail("id required for update", "update");
					const item = plan.items.find((candidate) => candidate.id === params.id);
					if (!item) return fail(`Item ${params.id} not found`, "update");
					if (params.text?.trim()) item.text = params.text.trim();
					if (params.status) item.status = params.status;
					return result("update", formatPlan(plan));
				}

				case "remove": {
					if (!params.id) return fail("id required for remove", "remove");
					const index = plan.items.findIndex((candidate) => candidate.id === params.id);
					if (index === -1) return fail(`Item ${params.id} not found`, "remove");
					plan.items.splice(index, 1);
					return result("remove", formatPlan(plan));
				}

				case "clear": {
					plan = { items: [], nextId: 1 };
					return result("clear", "Plan cleared");
				}

				case "list":
					return result("list", formatPlan(plan));

				default:
					return fail(`Unknown action: ${params.action}`, "list");
			}
		},
	});
}
