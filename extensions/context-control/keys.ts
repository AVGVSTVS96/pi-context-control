/**
 * Stable identity keys for context messages and their maskable aspects.
 *
 * pi's buildSessionContext() pushes each session entry's message object into
 * the context verbatim (the `context` event hands us a deep copy), so the
 * message's own fields — role, numeric timestamp, toolCallId — survive the
 * round trip and can be used to correlate what the panel shows (built from
 * the session) with what the context event delivers (about to hit the LLM).
 */

export type AnyMessage = {
	role: string;
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
	[key: string]: unknown;
};

/** Identity of one message across panel/tree and the context event. */
export function messageKey(m: AnyMessage): string {
	const tcid = m.role === "toolResult" ? (m.toolCallId ?? "") : "";
	return `${m.role}:${m.timestamp ?? 0}:${tcid}`;
}

/**
 * Maskable aspect leaf ids. Group ids are dotted paths ("assistant.reasoning",
 * "tool.tool-result.read"); leaves are prefixed per aspect kind so a message's
 * text and reasoning can be masked independently.
 */
export const leafId = {
	assistantText: (m: AnyMessage) => `text:${messageKey(m)}`,
	reasoning: (m: AnyMessage) => `think:${messageKey(m)}`,
	toolCall: (toolCallId: string) => `call:${toolCallId}`,
	toolResult: (toolCallId: string) => `result:${toolCallId}`,
	userText: (m: AnyMessage) => `utext:${messageKey(m)}`,
	userImage: (m: AnyMessage) => `uimg:${messageKey(m)}`,
	meta: (m: AnyMessage) => `meta:${messageKey(m)}`,
};

/** Group id constants (dotted hierarchy used by both tree and masking). */
export const groups = {
	assistant: "assistant",
	assistantText: "assistant.text",
	reasoning: "assistant.reasoning",
	toolCall: "assistant.tool-call",
	toolCallFor: (tool: string) => `assistant.tool-call.${tool}`,
	user: "user",
	userText: "user.text",
	userImage: "user.image",
	tool: "tool",
	toolResult: "tool.tool-result",
	toolResultFor: (tool: string) => `tool.tool-result.${tool}`,
	meta: "meta",
	metaFor: (role: string) => `meta.${role}`,
};
