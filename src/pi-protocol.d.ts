/**
 * Pi RPC protocol shapes that Dock depends on.
 *
 * Dock deliberately keeps no runtime (or build-time) dependency on the Pi
 * package: this file is a hand-written mirror of the subset we consume, taken
 * from `@earendil-works/pi-coding-agent` 1.4.x
 * (`dist/modes/rpc/rpc-types.d.ts`, `dist/modes/json-event.d.ts`,
 * `dist/core/session-manager.d.ts`, `dist/core/agent-session.d.ts`).
 *
 * When Pi changes the wire protocol, update this file first: `npm run typecheck`
 * then points at every consumer and producer (the E2E fixture) that drifts.
 */

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiTextBlock {
	type: "text";
	text: string;
}

export interface PiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface PiImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiImageBlock | PiToolCallBlock;
export type PiContent = string | readonly (PiTextBlock | PiThinkingBlock | PiImageBlock)[];

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiUserMessage {
	role: "user";
	content: PiContent;
	timestamp?: number;
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiContentBlock[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: PiUsage;
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId?: string;
	toolName: string;
	content: PiContent;
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export interface PiToolOutput {
	content?: PiContent;
	partialResult?: PiToolOutput;
	details?: unknown;
	isError?: boolean;
}

export interface PiModel {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface PiSessionState {
	model?: PiModel;
	thinkingLevel: PiThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
}

export interface PiSessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: unknown;
}

export interface PiSlashCommand {
	name: string;
	description?: string;
	source?: string;
}

export interface PiCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

/** Every session entry Dock reads carries at least these fields. */
export interface PiEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface PiMessageEntry extends PiEntryBase {
	type: "message";
	message: PiMessage;
}

export interface PiCustomEntry extends PiEntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface PiSessionInfoEntry extends PiEntryBase {
	type: "session_info";
	name?: string;
}

export interface PiModelChangeEntry extends PiEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface PiThinkingLevelChangeEntry extends PiEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export type PiSessionEntry =
	| PiMessageEntry
	| PiCustomEntry
	| PiSessionInfoEntry
	| PiModelChangeEntry
	| PiThinkingLevelChangeEntry;

export interface PiSessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	version?: number;
}

/** One JSONL line in `~/.pi/agent/sessions/--<cwd>--/*.jsonl`. */
export type PiSessionLine = PiSessionHeader | PiSessionEntry;

export type PiAssistantMessageEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCallBlock };

export interface PiExtensionUIRequestBase {
	type: "extension_ui_request";
	id: string;
}

export type PiExtensionUIRequest =
	| (PiExtensionUIRequestBase & { method: "select"; title: string; options: string[]; timeout?: number })
	| (PiExtensionUIRequestBase & {
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  })
	| (PiExtensionUIRequestBase & { method: "input"; title: string; placeholder?: string; timeout?: number })
	| (PiExtensionUIRequestBase & {
			method: "editor";
			title: string;
			prefill?: string;
			timeout?: number;
	  })
	| (PiExtensionUIRequestBase & {
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  })
	| (PiExtensionUIRequestBase & {
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  })
	| (PiExtensionUIRequestBase & {
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  })
	| (PiExtensionUIRequestBase & { method: "setTitle"; title: string })
	| (PiExtensionUIRequestBase & { method: "set_editor_text"; text: string });

/** Records Pi streams on stdout while an agent run is in progress. */
export type PiRecord =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
	| { type: "message_start"; message: PiMessage }
	| {
			type: "message_update";
			/** Pi always sends the cumulative message; Dock only reads the delta event. */
			message?: PiMessage;
			assistantMessageEvent: PiAssistantMessageEvent;
	  }
	| { type: "message_end"; message: PiMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: PiToolOutput;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: PiToolOutput;
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
	| { type: "thinking_level_changed"; level: PiThinkingLevel }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: PiCompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "entry_appended"; entry: PiSessionEntry }
	| PiExtensionUIRequest;

export type PiCommandType =
	| "prompt"
	| "steer"
	| "follow_up"
	| "abort"
	| "clear_queue"
	| "new_session"
	| "switch_session"
	| "set_model"
	| "set_thinking_level"
	| "compact"
	| "set_session_name"
	| "get_state"
	| "get_messages"
	| "get_session_stats"
	| "get_available_models"
	| "get_available_thinking_levels"
	| "get_commands"
	| "get_entries"
	| "get_tree"
	| "export_html"
	| "extension_ui_response";

export interface PiCommand {
	id?: string;
	type: PiCommandType;
	[key: string]: unknown;
}

/** `data` payload of a successful response, keyed by command type. */
export interface PiCommandData {
	prompt: { disposition: "started" | "queued" };
	steer: { disposition: "started" | "queued" };
	follow_up: { disposition: "started" | "queued" };
	abort: undefined;
	clear_queue: { steering: string[]; followUp: string[] };
	new_session: { cancelled: boolean };
	switch_session: { cancelled: boolean };
	set_model: PiModel;
	set_thinking_level: undefined;
	compact: PiCompactionResult;
	set_session_name: undefined;
	get_state: PiSessionState;
	get_messages: { messages: PiMessage[] };
	get_session_stats: PiSessionStats;
	get_available_models: { models: PiModel[] };
	get_available_thinking_levels: { levels: PiThinkingLevel[] };
	get_commands: { commands: PiSlashCommand[] };
	get_entries: { entries: PiSessionEntry[]; leafId: string | null };
	get_tree: { tree: PiTreeNode[]; leafId: string | null };
	export_html: { path: string };
	extension_ui_response: undefined;
}

export interface PiTreeNode {
	entry: PiSessionEntry;
	children: PiTreeNode[];
	label?: string;
}

export type PiResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export interface PiExitInfo {
	reason: string;
	stderr: string;
	stopping: boolean;
}
