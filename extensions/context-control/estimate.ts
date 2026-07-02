/**
 * Block-level token estimation.
 *
 * Mirrors pi's estimateTokens() (chars / 4, flat cost per image) but at
 * content-block granularity so the tree can attribute tokens to text vs
 * reasoning vs individual tool calls. Includes the thinking-signature
 * correction from pi-treebase: Claude thinking signatures are encrypted
 * high-entropy payloads whose provider-side cost tracks chars, not chars/4.
 */

import type { AnyMessage } from "./keys.ts";

/** Matches pi's ESTIMATED_IMAGE_CHARS / 4 ballpark for one image block. */
export const IMAGE_TOKENS = 1500;

export function estimateChars(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateTextBlock(block: { text?: string }): number {
	return estimateChars(block.text ?? "");
}

export function estimateThinkingBlock(block: { thinking?: string; thinkingSignature?: unknown }): number {
	const base = estimateChars(block.thinking ?? "");
	const sig = block.thinkingSignature;
	if (!sig) return base;
	const sigChars = typeof sig === "string" ? sig.length : JSON.stringify(sig).length;
	return base + sigChars;
}

export function estimateToolCallBlock(block: { name?: string; arguments?: unknown }): number {
	const name = block.name ?? "";
	let args = "";
	try {
		args = JSON.stringify(block.arguments ?? {}) ?? "";
	} catch {
		args = "";
	}
	return Math.ceil((name.length + args.length) / 4);
}

/** Estimate string-or-blocks content (user messages, tool results, custom). */
export function estimateContent(content: unknown): number {
	if (typeof content === "string") return estimateChars(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") tokens += estimateTextBlock(block);
		else if (block.type === "image") tokens += IMAGE_TOKENS;
	}
	return tokens;
}

/** Whole-message estimate, consistent with the block-level functions above. */
export function estimateMessage(m: AnyMessage): number {
	switch (m.role) {
		case "assistant": {
			let tokens = 0;
			const content = Array.isArray(m.content) ? m.content : [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text") tokens += estimateTextBlock(block);
				else if (block.type === "thinking") tokens += estimateThinkingBlock(block);
				else if (block.type === "toolCall") tokens += estimateToolCallBlock(block);
			}
			return tokens;
		}
		case "user":
		case "toolResult":
		case "custom":
			return estimateContent(m.content);
		case "bashExecution":
			return estimateChars(`${(m as any).command ?? ""}${(m as any).output ?? ""}`);
		case "branchSummary":
		case "compactionSummary":
			return estimateChars(String((m as any).summary ?? ""));
		default:
			return estimateContent(m.content);
	}
}

/** 84776 -> "84_776" (column style used in the tree). */
export function formatExact(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	return n.toLocaleString("en-US").replace(/,/g, "_");
}

/** 316_312 -> "316.3K", 950 -> "950" (header style). */
export function formatCompact(tokens: number): string {
	const n = Math.max(0, Math.round(tokens));
	if (n < 1000) return String(n);
	const k = n / 1000;
	if (k < 100) return `${k.toFixed(1)}K`;
	return `${Math.round(k)}K`;
}
