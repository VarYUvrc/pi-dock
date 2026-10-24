/**
 * In-memory view of the assistant message currently being streamed.
 * Used only for snapshots (page reload during a run); rendering itself is
 * driven by the event stream in the browser.
 */
export class LiveState {
	#blocks = [];
	#tools = new Map();

	reset() {
		this.#blocks = [];
		this.#tools.clear();
	}

	apply(record) {
		switch (record.type) {
			case "agent_start":
				this.reset();
				break;
			case "message_start":
				if (record.message?.role === "assistant") this.#blocks = [];
				break;
			case "message_update":
				this.#applyUpdate(record.assistantMessageEvent);
				break;
			case "tool_execution_start":
				this.#tools.set(record.toolCallId, {
					id: record.toolCallId,
					name: record.toolName,
					args: record.args,
					status: "running",
					output: "",
					isError: false,
				});
				break;
			case "tool_execution_update": {
				const tool = this.#tools.get(record.toolCallId);
				if (tool) tool.output = toolText(record.partialResult);
				break;
			}
			case "tool_execution_end": {
				const tool = this.#tools.get(record.toolCallId);
				if (tool) {
					tool.status = record.isError ? "error" : "done";
					tool.isError = Boolean(record.isError);
					tool.output = toolText(record.result) || tool.output;
					tool.durationMs = record.durationMs;
				}
				break;
			}
			case "message_end":
				if (record.message?.role === "assistant") this.#blocks = [];
				break;
			case "agent_settled":
				this.reset();
				break;
		}
	}

	#applyUpdate(update) {
		if (!update) return;
		const index = update.contentIndex;
		const block = this.#blocks[index];
		switch (update.type) {
			case "text_start":
				this.#blocks[index] = { type: "text", text: "" };
				break;
			case "text_delta":
				if (block?.type === "text") block.text += update.delta;
				break;
			case "text_end":
				this.#blocks[index] = { type: "text", text: update.content };
				break;
			case "thinking_start":
				this.#blocks[index] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				if (block?.type === "thinking") block.thinking += update.delta;
				break;
			case "thinking_end":
				this.#blocks[index] = { type: "thinking", thinking: update.content };
				break;
			case "toolcall_start":
				this.#blocks[index] = {
					type: "toolCall",
					id: update.id,
					name: update.toolName,
					arguments: {},
					partialArgs: "",
				};
				break;
			case "toolcall_delta":
				if (block?.type === "toolCall") block.partialArgs += update.delta;
				break;
			case "toolcall_end": {
				const call = update.toolCall;
				this.#blocks[index] = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: call.arguments ?? {},
				};
				break;
			}
		}
	}

	snapshot() {
		const blocks = this.#blocks.filter(Boolean);
		return {
			blocks,
			tools: Object.fromEntries(this.#tools),
		};
	}
}

export function toolText(result) {
	if (!result) return "";
	if (typeof result === "string") return result;
	const content = result.content ?? result.partialResult?.content ?? [];
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}
