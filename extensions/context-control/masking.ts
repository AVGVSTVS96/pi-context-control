/**
 * Mask state + the context transform.
 *
 * Masking is non-destructive: the session file is never touched. On every
 * `context` event we receive a deep copy of the outgoing messages and return
 * a filtered/rewritten array. Unmasking simply stops filtering on the next
 * LLM call.
 *
 * Pairing safety: providers require toolCall/toolResult pairing, so
 *  - masking a tool RESULT replaces its content with a short stub (the call
 *    and pairing stay intact);
 *  - masking a tool CALL removes the call block AND drops its paired result
 *    message entirely.
 */

import { estimateContent, formatCompact } from "./estimate.ts";
import { type AnyMessage, groups, leafId } from "./keys.ts";
import { collectCallSummaries, firstLine, textOf } from "./summarize.ts";

export class MaskState {
	private masked = new Set<string>();

	has(id: string): boolean {
		return this.masked.has(id);
	}

	/** Effective mask: the node itself or any ancestor group is masked. */
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

/** Aspect chains — shared vocabulary between the tree model and the transform. */
export const chains = {
	assistantText: (m: AnyMessage) => [groups.assistant, groups.assistantText, leafId.assistantText(m)],
	reasoning: (m: AnyMessage) => [groups.assistant, groups.reasoning, leafId.reasoning(m)],
	toolCall: (tool: string, id: string) => [
		groups.assistant,
		groups.toolCall,
		groups.toolCallFor(tool),
		leafId.toolCall(id),
	],
	toolResult: (m: AnyMessage) => [
		groups.tool,
		groups.toolResult,
		groups.toolResultFor(m.toolName ?? "unknown"),
		leafId.toolResult(m.toolCallId ?? ""),
	],
	userText: (m: AnyMessage) => [groups.user, groups.userText, leafId.userText(m)],
	userImage: (m: AnyMessage) => [groups.user, groups.userImage, leafId.userImage(m)],
	meta: (m: AnyMessage) => [groups.meta, groups.metaFor(m.role), leafId.meta(m)],
};

/** Minimal structural view of a tree node used for mask toggling. */
export interface MaskableNode {
	id: string;
	parent: MaskableNode | null;
	children: MaskableNode[];
	selfMasked: boolean;
	masked: boolean;
}

/**
 * Toggle a node's mask. Unmasking a node whose mask is inherited from an
 * ancestor "explodes" that ancestor: the ancestor's mask is removed and every
 * sibling subtree that was covered by it gets its own mask, so only the
 * requested node becomes visible again.
 */
export function toggleNodeMask(state: MaskState, node: MaskableNode): void {
	if (node.selfMasked) {
		state.remove(node.id);
		return;
	}
	if (!node.masked) {
		state.add(node.id);
		return;
	}
	// Inherited mask: explode each self-masked ancestor, nearest first.
	for (;;) {
		const path: MaskableNode[] = [node];
		let ancestor = node.parent;
		while (ancestor && !state.has(ancestor.id)) {
			path.push(ancestor);
			ancestor = ancestor.parent;
		}
		if (!ancestor) return;
		path.push(ancestor);
		path.reverse(); // [maskedAncestor, ..., node]
		state.remove(ancestor.id);
		for (let i = 0; i < path.length - 1; i++) {
			const keep = path[i + 1];
			for (const child of path[i].children) {
				if (child !== keep) state.add(child.id);
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

	for (const m of messages) {
		switch (m.role) {
			case "assistant": {
				const transformed = transformAssistant(m, state, droppedCalls);
				if (transformed) out.push(transformed);
				break;
			}
			case "toolResult": {
				if (m.toolCallId && droppedCalls.has(m.toolCallId)) break;
				if (state.anyMasked(chains.toolResult(m))) {
					const stub = maskedResultStub(m, m.toolCallId ? callSummaries.get(m.toolCallId) : undefined);
					out.push({ ...m, content: [{ type: "text", text: stub }], details: undefined });
				} else {
					out.push(m);
				}
				break;
			}
			case "user": {
				const transformed = transformUser(m, state);
				if (transformed) out.push(transformed);
				break;
			}
			case "custom":
			case "bashExecution":
			case "branchSummary":
			case "compactionSummary": {
				if (!state.anyMasked(chains.meta(m))) out.push(m);
				break;
			}
			default:
				out.push(m);
		}
	}
	return out;
}

function transformAssistant(m: AnyMessage, state: MaskState, droppedCalls: Set<string>): AnyMessage | null {
	const content = Array.isArray(m.content) ? m.content : [];
	let changed = false;
	const kept: unknown[] = [];

	for (const block of content) {
		if (!block || typeof block !== "object") {
			kept.push(block);
			continue;
		}
		if (block.type === "text" && state.anyMasked(chains.assistantText(m))) {
			changed = true;
			continue;
		}
		if (block.type === "thinking" && state.anyMasked(chains.reasoning(m))) {
			changed = true;
			continue;
		}
		if (block.type === "toolCall") {
			const chain = chains.toolCall(block.name ?? "unknown", block.id ?? "");
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

function transformUser(m: AnyMessage, state: MaskState): AnyMessage | null {
	const textMasked = state.anyMasked(chains.userText(m));
	const imageMasked = state.anyMasked(chains.userImage(m));
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
