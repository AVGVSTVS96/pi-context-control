/**
 * Stable identity keys for context messages and their maskable aspects.
 *
 * pi's buildSessionContext() pushes each session entry's message object into
 * the context verbatim (the `context` event hands us a deep copy), so the
 * message's own fields (role, numeric timestamp, toolCallId) survive the
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

/**
 * Chronological group ids. A "turn" is the section starting at each user
 * message (keyed by that message so ids stay stable as the session grows);
 * a "pair" is one tool call + its result shown as a single row in the
 * session view. Masking a pair covers only the result (stubbed in place),
 * so the pair id appears in the result's chain but not the call's.
 */
export const TURN_PRE = "turn:pre";

export function turnIdFor(userMessage: AnyMessage): string {
	return `turn:${messageKey(userMessage)}`;
}

/** Walk helper: advance the current turn id when a user message starts a new one. */
export function advanceTurn(current: string, m: AnyMessage): string {
	return m.role === "user" ? turnIdFor(m) : current;
}

export function pairId(toolCallId: string): string {
	return `pair:${toolCallId}`;
}

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
