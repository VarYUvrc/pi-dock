/**
 * Pi types Dock consumes, derived from the official packages.
 *
 * The Pi packages are devDependencies only: no runtime dependency is added,
 * but the RPC wire protocol, session JSONL, and extension API are checked
 * against the same declarations Pi ships. When Pi changes, bump the
 * devDependencies and let `npm run typecheck` point at every consumer.
 */

import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcCommandType,
	RpcExtensionUIRequest,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	SessionEntry,
	SessionHeader,
	SessionStats,
	SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

export type PiThinkingLevel = RpcSessionState["thinkingLevel"];
export type PiModel = Model<string>;

export type PiTextBlock = TextContent;
export type PiThinkingBlock = ThinkingContent;
export type PiImageBlock = ImageContent;
export type PiToolCallBlock = ToolCall;
export type PiContentBlock = TextContent | ThinkingContent | ImageContent | ToolCall;
export type PiUserContent = UserMessage["content"];
export type PiContent = string | readonly (TextContent | ImageContent)[];
export type PiUsage = Usage;

export type PiMessage = Message;
export type PiAgentMessage = PiSessionEntry extends infer _ ? Extract<SessionEntry, { type: "message" }>["message"] : never;
export type PiUserMessage = UserMessage;
export type PiAssistantMessage = AssistantMessage;
export type PiToolResultMessage = ToolResultMessage;

export type PiSessionState = RpcSessionState;
export type PiSessionStats = SessionStats;
export type PiSlashCommand = RpcSlashCommand;
export type PiSessionEntry = SessionEntry;
export type PiSessionHeader = SessionHeader;
export type PiSessionLine = PiSessionHeader | PiSessionEntry;
export type PiTreeNode = SessionTreeNode;

export type PiRecord = JsonAgentSessionEvent | RpcExtensionUIRequest;
export type PiAssistantMessageEvent = Extract<
	JsonAgentSessionEvent,
	{ type: "message_update" }
>["assistantMessageEvent"];
export type PiToolOutput = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>["result"];
export type PiExtensionUIRequest = RpcExtensionUIRequest;
export type PiCommand = RpcCommand;
export type PiCommandType = RpcCommandType;
export type PiResponse = RpcResponse;

/** `data` payload of a successful response, keyed by command type. */
export type PiCommandData<Type extends PiCommandType> = Extract<
	RpcResponse,
	{ command: Type; success: true }
> extends { data: infer Data }
	? Data
	: undefined;

export interface PiExitInfo {
	reason: string;
	stderr: string;
	stopping: boolean;
}
