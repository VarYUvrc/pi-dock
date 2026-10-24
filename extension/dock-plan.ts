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

	const reconstruct = (ctx: ExtensionContext) => {
		plan = { items: [], nextId: 1 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "dock_plan") continue;
			const restored = planFromDetails(message.details);
			if (restored) plan = restored;
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "dock_plan",
		label: "Plan",
		description:
			"Track a multi-step implementation plan. Use it for long tasks with several distinct steps; skip it for short questions or single-step work. Call set with the complete ordered plan to create or reorder it, update to change one item, add to append an item, remove to delete one, and clear when finished. Reuse item ids: mark the current item in_progress and completed items done. Update the plan as work progresses or when the approach changes.",
		promptSnippet: "Track a multi-step plan and its progress",
		executionMode: "sequential",
		parameters: PlanParams,

		async execute(_toolCallId, params) {
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
