/**
 * The shared chronological index of every maskable leaf in the context.
 *
 * Both panel views (general/type-grouped and session/chronological), the
 * preset rules, and mask toggling consume this one walk, so they can never
 * disagree about what exists, which turn it belongs to, or which group ids
 * cover it.
 */

import {
	estimateChars,
	estimateContent,
	estimateTextBlock,
	estimateThinkingBlock,
	estimateToolCallBlock,
	IMAGE_TOKENS,
} from "./estimate.ts";
import { advanceTurn, type AnyMessage, TURN_PRE, turnIdFor } from "./keys.ts";
import { chains, maskedResultStub, type MaskState } from "./masking.ts";
import { firstLine, summarizeArgs, textOf } from "./summarize.ts";

export type LeafKind =
	| "assistant-text"
	| "reasoning"
	| "tool-call"
	| "tool-result"
	| "user-text"
	| "user-image"
	| "meta"
	/** Synthetic tree row for a summarized span — never produced by indexLeaves. */
	| "summary";

export interface LeafInfo {
	id: string;
	kind: LeafKind;
	/** Covering group ids: type hierarchy + turn (+ pair for results), own id last. */
	chain: readonly string[];
	turnId: string;
	tool?: string;
	toolCallId?: string;
	/** Original role for meta leaves (custom, bashExecution, …). */
	metaRole?: string;
	label: string;
	raw: number;
	/** What the stub costs if this tool result is masked. */
	stubTokens?: number;
	/** Synthetic summary rows only: the digest, for the panel's detail view. */
	summary?: { text: string; model: string };
	timestamp: number;
}

export interface TurnInfo {
	id: string;
	label: string;
	messageCount: number;
}

export interface LeafIndex {
	leaves: LeafInfo[];
	/** Turns in chronological order (only those that actually have content). */
	turns: TurnInfo[];
	messageCount: number;
	roleCounts: { assistant: number; user: number; tool: number };
}

/** Tool calls masked away entirely; their paired results are dropped, not stubbed. */
export function droppedCallIds(idx: LeafIndex, state: MaskState): Set<string> {
	const dropped = new Set<string>();
	for (const leaf of idx.leaves) {
		if (leaf.kind === "tool-call" && leaf.toolCallId && state.anyMasked(leaf.chain)) {
			dropped.add(leaf.toolCallId);
		}
	}
	return dropped;
}

/** What a leaf costs after the mask set: 0 when dropped, the stub cost when stubbed. */
export function leafEffective(leaf: LeafInfo, state: MaskState, droppedCalls: Set<string>): number {
	if (leaf.kind === "tool-result") {
		if (leaf.toolCallId && droppedCalls.has(leaf.toolCallId)) return 0;
		if (state.anyMasked(leaf.chain)) return Math.min(leaf.raw, leaf.stubTokens ?? 0);
		return leaf.raw;
	}
	return state.anyMasked(leaf.chain) ? 0 : leaf.raw;
}

/** Leaves the current mask set actually hides (drives the widget count). */
export function maskedLeafCount(state: MaskState, idx: LeafIndex): number {
	return idx.leaves.reduce((n, leaf) => n + (state.anyMasked(leaf.chain) ? 1 : 0), 0);
}

/**
 * Drop mask ids that reference content no longer in the session (turns,
 * pairs, or individual items — anything with a ":" in its id). Such ids can
 * linger after compaction or from older toggle semantics; they hide nothing
 * but inflate the mask count. Group ids (no ":") are kept: they are armed
 * rules that legitimately cover matching content as it arrives.
 */
export function pruneStaleMasks(state: MaskState, idx: LeafIndex): number {
	const known = new Set<string>();
	for (const leaf of idx.leaves) for (const id of leaf.chain) known.add(id);
	let pruned = 0;
	for (const id of state.toJSON()) {
		if (id.includes(":") && !known.has(id)) {
			state.remove(id);
			pruned++;
		}
	}
	return pruned;
}

export function indexLeaves(messages: AnyMessage[]): LeafIndex {
	const leaves: LeafInfo[] = [];
	const turns: TurnInfo[] = [];
	const turnById = new Map<string, TurnInfo>();
	const callSummaries = new Map<string, string>();
	const roleCounts = { assistant: 0, user: 0, tool: 0 };
	let turnId = TURN_PRE;

	const turn = (): TurnInfo => {
		let t = turnById.get(turnId);
		if (!t) {
			t = { id: turnId, label: "before first prompt", messageCount: 0 };
			turnById.set(turnId, t);
			turns.push(t);
		}
		return t;
	};

	for (const m of messages) {
		if (m.role === "user") {
			turnId = turnIdFor(m);
			const t: TurnInfo = {
				id: turnId,
				label: firstLine(typeof m.content === "string" ? m.content : textOf(m.content), 56),
				messageCount: 0,
			};
			turnById.set(turnId, t);
			turns.push(t);
		} else {
			turnId = advanceTurn(turnId, m);
		}
		const ts = m.timestamp ?? 0;

		switch (m.role) {
			case "assistant": {
				roleCounts.assistant++;
				turn().messageCount++;
				const content = Array.isArray(m.content) ? m.content : [];
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text") {
						const chain = chains.assistantText(m, turnId);
						leaves.push({
							id: chain[chain.length - 1],
							kind: "assistant-text",
							chain,
							turnId,
							label: firstLine(block.text ?? ""),
							raw: estimateTextBlock(block),
							timestamp: ts,
						});
					} else if (block.type === "thinking") {
						const chain = chains.reasoning(m, turnId);
						leaves.push({
							id: chain[chain.length - 1],
							kind: "reasoning",
							chain,
							turnId,
							label: firstLine(block.thinking ?? ""),
							raw: estimateThinkingBlock(block),
							timestamp: ts,
						});
					} else if (block.type === "toolCall") {
						const name = block.name ?? "unknown";
						const summary = summarizeArgs(block.arguments);
						if (block.id) callSummaries.set(block.id, summary);
						const chain = chains.toolCall(name, block.id ?? "", turnId);
						leaves.push({
							id: chain[chain.length - 1],
							kind: "tool-call",
							chain,
							turnId,
							tool: name,
							toolCallId: block.id,
							label: summary,
							raw: estimateToolCallBlock(block),
							timestamp: ts,
						});
					}
				}
				break;
			}
			case "user": {
				roleCounts.user++;
				turn().messageCount++;
				if (typeof m.content === "string") {
					const chain = chains.userText(m, turnId);
					leaves.push({
						id: chain[chain.length - 1],
						kind: "user-text",
						chain,
						turnId,
						label: firstLine(m.content),
						raw: estimateContent(m.content),
						timestamp: ts,
					});
				} else if (Array.isArray(m.content)) {
					let textRaw = 0;
					let imageCount = 0;
					let label = "";
					for (const block of m.content) {
						if (block?.type === "text") {
							textRaw += estimateTextBlock(block);
							if (!label) label = firstLine(block.text ?? "");
						} else if (block?.type === "image") {
							imageCount++;
						}
					}
					if (textRaw > 0 || imageCount === 0) {
						const chain = chains.userText(m, turnId);
						leaves.push({
							id: chain[chain.length - 1],
							kind: "user-text",
							chain,
							turnId,
							label,
							raw: textRaw,
							timestamp: ts,
						});
					}
					if (imageCount > 0) {
						const chain = chains.userImage(m, turnId);
						leaves.push({
							id: chain[chain.length - 1],
							kind: "user-image",
							chain,
							turnId,
							label: imageCount === 1 ? "image" : `${imageCount} images`,
							raw: imageCount * IMAGE_TOKENS,
							timestamp: ts,
						});
					}
				}
				break;
			}
			case "toolResult": {
				roleCounts.tool++;
				turn().messageCount++;
				const chain = chains.toolResult(m, turnId);
				const summary = m.toolCallId ? callSummaries.get(m.toolCallId) : undefined;
				leaves.push({
					id: chain[chain.length - 1],
					kind: "tool-result",
					chain,
					turnId,
					tool: m.toolName ?? "unknown",
					toolCallId: m.toolCallId,
					label: firstLine(textOf(m.content)),
					raw: estimateContent(m.content),
					stubTokens: estimateChars(maskedResultStub(m, summary)),
					timestamp: ts,
				});
				break;
			}
			case "custom":
			case "bashExecution":
			case "branchSummary":
			case "compactionSummary": {
				turn().messageCount++;
				const chain = chains.meta(m, turnId);
				leaves.push({
					id: chain[chain.length - 1],
					kind: "meta",
					chain,
					turnId,
					metaRole: m.role,
					label: metaLabel(m),
					raw: estimateMeta(m),
					timestamp: ts,
				});
				break;
			}
		}
	}

	const usedTurns = new Set(leaves.map((l) => l.turnId));
	return {
		leaves,
		turns: turns.filter((t) => usedTurns.has(t.id)),
		messageCount: messages.length,
		roleCounts,
	};
}

function estimateMeta(m: AnyMessage): number {
	if (m.role === "bashExecution") {
		return estimateChars(String((m as any).command ?? "") + String((m as any).output ?? ""));
	}
	if (m.role === "branchSummary" || m.role === "compactionSummary") {
		return estimateChars(String((m as any).summary ?? ""));
	}
	return estimateContent(m.content);
}

function metaLabel(m: AnyMessage): string {
	if (m.role === "bashExecution") return firstLine(String((m as any).command ?? ""));
	if (m.role === "custom") return String((m as any).customType ?? "custom");
	if (m.role === "branchSummary") return "branch summary";
	if (m.role === "compactionSummary") return "compaction summary";
	return m.role;
}
