/**
 * Small text summaries shared by tree row labels and masked-result stubs:
 * first-line previews, tool-call argument summaries, and a per-session map
 * of toolCallId → argument summary so a masked result's stub can say what
 * the call was for.
 */

import type { AnyMessage } from "./keys.ts";

export function firstLine(text: string, max = 64): string {
	const line = text.trimStart().split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Pick the most human-meaningful argument of a tool call. */
export function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query", "url"]) {
		if (typeof a[key] === "string") return firstLine(a[key] as string, 48);
	}
	try {
		return firstLine(JSON.stringify(a), 48);
	} catch {
		return "";
	}
}

/** First text block of string-or-blocks content. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block?.type === "text" && block.text) return block.text;
	}
	return "";
}

/** toolCallId → argument summary, for annotating masked-result stubs. */
export function collectCallSummaries(messages: AnyMessage[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block?.type === "toolCall" && block.id) {
				map.set(block.id, summarizeArgs(block.arguments));
			}
		}
	}
	return map;
}
