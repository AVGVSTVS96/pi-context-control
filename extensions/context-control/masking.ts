/**
 * Mask state + the context transform.
 *
 * Masking is non-destructive: the session file is never touched. On every
 * `context` event we receive a deep copy of the outgoing messages and return
 * a filtered/rewritten array. Unmasking simply stops filtering on the next
 * LLM call.
 *
 * Every maskable leaf is covered by a chain of group ids from two hierarchies
 * at once: its type ancestors (assistant → reasoning, tool → tool-result →
 * read) and its chronological ancestors (the turn it happened in, and for a
 * tool result the call/result pair row). A mask on any id in the chain hides
 * the leaf, which is what lets the general view and the session view drive
 * the same state.
 *
 * Pairing safety: providers require toolCall/toolResult pairing, so
 *  - masking a tool RESULT (or its pair row) replaces its content with a
 *    short stub (the call and pairing stay intact);
 *  - masking a tool CALL removes the call block AND drops its paired result
 *    message entirely.
 */

import { estimateContent, formatCompact } from "./estimate.ts";
import { advanceTurn, type AnyMessage, groups, leafId, pairId, TURN_PRE } from "./keys.ts";
import { collectCallSummaries, firstLine, textOf } from "./summarize.ts";

export class MaskState {
	private masked = new Set<string>();

	has(id: string): boolean {
		return this.masked.has(id);
	}

	/** Effective mask: any id in the leaf's covering chain is masked. */
	anyMasked(chain: readonly string[]): boolean {
		for (const id of chain) if (this.masked.has(id)) return true;
		return false;
	}

	add(id: string): void {
		this.masked.add(id);
	}

	remove(id: string): void {
		this.masked.delete(id);
	}

	get size(): number {
		return this.masked.size;
	}

	toJSON(): string[] {
		return [...this.masked];
	}

	load(ids: readonly string[] | undefined): void {
		this.masked = new Set(ids ?? []);
	}
}

/**
 * Covering chains: shared vocabulary between the leaf index, the trees, and
 * the transform. Ordered outermost group → leaf id (own id included last).
 * The pair id covers only the RESULT: masking a pair row stubs the result
 * but keeps the call, so the exchange stays visible to the model.
 */
export const chains = {
	assistantText: (m: AnyMessage, turnId: string) => [
		groups.assistant,
		groups.assistantText,
		turnId,
		leafId.assistantText(m),
	],
	reasoning: (m: AnyMessage, turnId: string) => [groups.assistant, groups.reasoning, turnId, leafId.reasoning(m)],
	toolCall: (tool: string, id: string, turnId: string) => [
		groups.assistant,
		groups.toolCall,
		groups.toolCallFor(tool),
		turnId,
		leafId.toolCall(id),
	],
	toolResult: (m: AnyMessage, turnId: string) => [
		groups.tool,
		groups.toolResult,
		groups.toolResultFor(m.toolName ?? "unknown"),
		turnId,
		pairId(m.toolCallId ?? ""),
		leafId.toolResult(m.toolCallId ?? ""),
	],
	userText: (m: AnyMessage, turnId: string) => [groups.user, groups.userText, turnId, leafId.userText(m)],
	userImage: (m: AnyMessage, turnId: string) => [groups.user, groups.userImage, turnId, leafId.userImage(m)],
	meta: (m: AnyMessage, turnId: string) => [groups.meta, groups.metaFor(m.role), turnId, leafId.meta(m)],
};

/** Minimal structural view of a tree node used for mask toggling. */
export interface MaskableNode {
	id: string;
	isLeaf: boolean;
	children: MaskableNode[];
	/** Leaves carry their full covering chain (own id included). */
	chain?: readonly string[];
}

/** Leaf reference for explode: id + covering chain. */
export interface LeafRef {
	id: string;
	chain: readonly string[];
}

function collectLeafRefs(node: MaskableNode, out: LeafRef[] = []): LeafRef[] {
	if (node.isLeaf) {
		out.push({ id: node.id, chain: node.chain ?? [node.id] });
		return out;
	}
	for (const child of node.children) collectLeafRefs(child, out);
	return out;
}

/**
 * Toggle a node's mask, a clean two-state cycle no matter how the current
 * masks came about:
 *
 *   anything masked in/over this subtree → clear it all (fully visible)
 *   nothing masked                       → mask the whole node
 *
 * So a partially-masked parent unmasks all children first, and masks them
 * all on the next press. Clearing a mask held by a group id that also covers
 * leaves OUTSIDE this subtree "explodes" it at leaf granularity: the group id
 * is removed and every other leaf it covered gets its own mask, so only the
 * requested subtree comes back. Because coverage is chain-based, this works
 * no matter which view created the mask (a type group, a turn, or a pair).
 */
export function toggleNodeMask(state: MaskState, node: MaskableNode, allLeaves: readonly LeafRef[]): void {
	const targets = collectLeafRefs(node);
	const targetIds = new Set(targets.map((t) => t.id));
	if (!state.has(node.id) && !targets.some((t) => state.anyMasked(t.chain))) {
		state.add(node.id);
		return;
	}
	state.remove(node.id);
	// Each pass removes at least one covering id and never re-adds one, so
	// this terminates; the guard is belt-and-suspenders.
	for (let guard = 0; guard < 1000; guard++) {
		const covering = new Set<string>();
		for (const t of targets) {
			if (state.has(t.id)) state.remove(t.id);
			for (const gid of t.chain) {
				if (gid !== t.id && state.has(gid)) covering.add(gid);
			}
		}
		if (covering.size === 0) return;
		for (const gid of covering) {
			state.remove(gid);
			for (const leaf of allLeaves) {
				if (targetIds.has(leaf.id)) continue;
				if (leaf.chain.includes(gid)) state.add(leaf.id);
			}
		}
	}
}

/**
 * The stub left in place of a masked tool result. Says what the call was for
 * and how the result began, so the model can decide whether the hidden
 * content matters before asking for it back. Exported so the tree can price
 * the stub exactly.
 */
export function maskedResultStub(m: AnyMessage, callSummary?: string): string {
	const tokens = estimateContent(m.content);
	const tool = m.toolName ?? "tool";
	const target = callSummary ? ` for \`${callSummary}\`` : "";
	const preview = firstLine(textOf(m.content), 80);
	const began = preview ? ` It began: "${preview}".` : "";
	return `[${tool} result${target} hidden by the user via context-control (~${formatCompact(tokens)} tokens masked out).${began} Ask the user to unmask it if you need it.]`;
}

/**
 * Apply the mask set to an outgoing message array. Returns a new array;
 * unmasked messages are passed through by reference.
 */
export function applyMask(messages: AnyMessage[], state: MaskState): AnyMessage[] {
	if (state.size === 0) return messages;

	const callSummaries = collectCallSummaries(messages);
	const droppedCalls = new Set<string>();
	const out: AnyMessage[] = [];
	let turnId = TURN_PRE;

	for (const m of messages) {
		turnId = advanceTurn(turnId, m);
		switch (m.role) {
			case "assistant": {
				const transformed = transformAssistant(m, state, droppedCalls, turnId);
				if (transformed) out.push(transformed);
				break;
			}
			case "toolResult": {
				if (m.toolCallId && droppedCalls.has(m.toolCallId)) break;
				if (state.anyMasked(chains.toolResult(m, turnId))) {
					const stub = maskedResultStub(m, m.toolCallId ? callSummaries.get(m.toolCallId) : undefined);
					out.push({ ...m, content: [{ type: "text", text: stub }], details: undefined });
				} else {
					out.push(m);
				}
				break;
			}
			case "user": {
				const transformed = transformUser(m, state, turnId);
				if (transformed) out.push(transformed);
				break;
			}
			case "custom":
			case "bashExecution":
			case "branchSummary":
			case "compactionSummary": {
				if (!state.anyMasked(chains.meta(m, turnId))) out.push(m);
				break;
			}
			default:
				out.push(m);
		}
	}
	return out;
}

function transformAssistant(
	m: AnyMessage,
	state: MaskState,
	droppedCalls: Set<string>,
	turnId: string,
): AnyMessage | null {
	const content = Array.isArray(m.content) ? m.content : [];
	let changed = false;
	const kept: unknown[] = [];

	for (const block of content) {
		if (!block || typeof block !== "object") {
			kept.push(block);
			continue;
		}
		if (block.type === "text" && state.anyMasked(chains.assistantText(m, turnId))) {
			changed = true;
			continue;
		}
		if (block.type === "thinking" && state.anyMasked(chains.reasoning(m, turnId))) {
			changed = true;
			continue;
		}
		if (block.type === "toolCall") {
			const chain = chains.toolCall(block.name ?? "unknown", block.id ?? "", turnId);
			if (state.anyMasked(chain)) {
				if (block.id) droppedCalls.add(block.id);
				changed = true;
				continue;
			}
		}
		kept.push(block);
	}

	if (!changed) return m;
	if (kept.length === 0) return null;
	return { ...m, content: kept };
}

function transformUser(m: AnyMessage, state: MaskState, turnId: string): AnyMessage | null {
	const textMasked = state.anyMasked(chains.userText(m, turnId));
	const imageMasked = state.anyMasked(chains.userImage(m, turnId));
	if (!textMasked && !imageMasked) return m;

	if (typeof m.content === "string") {
		return textMasked ? null : m;
	}
	if (!Array.isArray(m.content)) return m;

	const kept = m.content.filter((block: any) => {
		if (!block || typeof block !== "object") return true;
		if (block.type === "text") return !textMasked;
		if (block.type === "image") return !imageMasked;
		return true;
	});
	if (kept.length === m.content.length) return m;
	if (kept.length === 0) return null;
	return { ...m, content: kept };
}
