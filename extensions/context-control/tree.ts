/**
 * Context tree model: role → content-type → tool → individual messages,
 * with occurrence counts and raw/effective token estimates per node.
 *
 * "raw" is what the item costs as recorded; "effective" is what it will cost
 * after the current mask set is applied (0 when dropped, a small stub cost
 * when a tool result is stubbed).
 */

import {
	estimateContent,
	estimateTextBlock,
	estimateThinkingBlock,
	estimateToolCallBlock,
	IMAGE_TOKENS,
} from "./estimate.ts";
import { type AnyMessage, groups, leafId } from "./keys.ts";
import { chains, type MaskState } from "./masking.ts";

/** Approximate cost of the stub text left in place of a masked tool result. */
export const RESULT_STUB_TOKENS = 35;

export interface TreeNode {
	id: string;
	label: string;
	/** Occurrence count shown as "Nx". */
	count: number;
	rawTokens: number;
	effectiveTokens: number;
	children: TreeNode[];
	parent: TreeNode | null;
	isLeaf: boolean;
	/** Own id masked directly (vs inherited from an ancestor). */
	selfMasked: boolean;
	/** Effectively masked (self or any ancestor). */
	masked: boolean;
}

export interface ContextTreeModel {
	roots: TreeNode[];
	messageCount: number;
	rawTotal: number;
	effectiveTotal: number;
}

function firstLine(text: string, max = 64): string {
	const line = text.trimStart().split("\n", 1)[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function summarizeArgs(args: unknown): string {
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

class TreeBuilder {
	private nodes = new Map<string, TreeNode>();
	private state: MaskState;
	roots: TreeNode[] = [];

	constructor(state: MaskState) {
		this.state = state;
	}

	group(id: string, label: string, parent: TreeNode | null): TreeNode {
		let node = this.nodes.get(id);
		if (node) return node;
		node = {
			id,
			label,
			count: 0,
			rawTokens: 0,
			effectiveTokens: 0,
			children: [],
			parent,
			isLeaf: false,
			selfMasked: this.state.has(id),
			masked: this.state.has(id) || (parent?.masked ?? false),
		};
		this.nodes.set(id, node);
		if (parent) parent.children.push(node);
		else this.roots.push(node);
		return node;
	}

	leaf(parent: TreeNode, id: string, label: string, rawTokens: number, effectiveTokens: number): void {
		const selfMasked = this.state.has(id);
		const masked = selfMasked || parent.masked;
		const node: TreeNode = {
			id,
			label,
			count: 1,
			rawTokens,
			effectiveTokens,
			children: [],
			parent,
			isLeaf: true,
			selfMasked,
			masked,
		};
		parent.children.push(node);
		// Propagate tokens and counts up the group chain.
		for (let p: TreeNode | null = parent; p; p = p.parent) {
			p.count += 1;
			p.rawTokens += rawTokens;
			p.effectiveTokens += effectiveTokens;
		}
	}
}

export function buildTree(messages: AnyMessage[], state: MaskState): ContextTreeModel {
	const b = new TreeBuilder(state);

	// Precompute tool calls dropped by call-masking: their paired results are
	// dropped entirely rather than stubbed, and assistant counts need them.
	const droppedCalls = new Set<string>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (block?.type === "toolCall" && block.id) {
				if (state.anyMasked(chains.toolCall(block.name ?? "unknown", block.id))) {
					droppedCalls.add(block.id);
				}
			}
		}
	}

	const assistant = b.group(groups.assistant, "assistant", null);
	const user = b.group(groups.user, "user", null);
	const tool = b.group(groups.tool, "tool", null);
	let meta: TreeNode | null = null;

	let assistantMessages = 0;
	let userMessages = 0;
	let toolMessages = 0;

	for (const m of messages) {
		switch (m.role) {
			case "assistant": {
				assistantMessages++;
				const content = Array.isArray(m.content) ? m.content : [];
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text") {
						const raw = estimateTextBlock(block);
						const masked = state.anyMasked(chains.assistantText(m));
						b.leaf(
							b.group(groups.assistantText, "text", assistant),
							leafId.assistantText(m),
							firstLine(block.text ?? ""),
							raw,
							masked ? 0 : raw,
						);
					} else if (block.type === "thinking") {
						const raw = estimateThinkingBlock(block);
						const masked = state.anyMasked(chains.reasoning(m));
						b.leaf(
							b.group(groups.reasoning, "reasoning", assistant),
							leafId.reasoning(m),
							firstLine(block.thinking ?? ""),
							raw,
							masked ? 0 : raw,
						);
					} else if (block.type === "toolCall") {
						const name = block.name ?? "unknown";
						const raw = estimateToolCallBlock(block);
						const masked = block.id ? droppedCalls.has(block.id) : false;
						const callGroup = b.group(groups.toolCall, "tool-call", assistant);
						b.leaf(
							b.group(groups.toolCallFor(name), name, callGroup),
							leafId.toolCall(block.id ?? ""),
							summarizeArgs(block.arguments),
							raw,
							masked ? 0 : raw,
						);
					}
				}
				break;
			}
			case "user": {
				userMessages++;
				const content = m.content;
				const textMasked = state.anyMasked(chains.userText(m));
				const imageMasked = state.anyMasked(chains.userImage(m));
				if (typeof content === "string") {
					const raw = estimateContent(content);
					b.leaf(
						b.group(groups.userText, "text", user),
						leafId.userText(m),
						firstLine(content),
						raw,
						textMasked ? 0 : raw,
					);
				} else if (Array.isArray(content)) {
					let textRaw = 0;
					let imageCount = 0;
					let label = "";
					for (const block of content) {
						if (block?.type === "text") {
							textRaw += estimateTextBlock(block);
							if (!label) label = firstLine(block.text ?? "");
						} else if (block?.type === "image") {
							imageCount++;
						}
					}
					if (textRaw > 0 || imageCount === 0) {
						b.leaf(
							b.group(groups.userText, "text", user),
							leafId.userText(m),
							label,
							textRaw,
							textMasked ? 0 : textRaw,
						);
					}
					if (imageCount > 0) {
						const raw = imageCount * IMAGE_TOKENS;
						b.leaf(
							b.group(groups.userImage, "image", user),
							leafId.userImage(m),
							imageCount === 1 ? "image" : `${imageCount} images`,
							raw,
							imageMasked ? 0 : raw,
						);
					}
				}
				break;
			}
			case "toolResult": {
				toolMessages++;
				const name = m.toolName ?? "unknown";
				const raw = estimateContent(m.content);
				const dropped = m.toolCallId ? droppedCalls.has(m.toolCallId) : false;
				const masked = state.anyMasked(chains.toolResult(m));
				const effective = dropped ? 0 : masked ? Math.min(raw, RESULT_STUB_TOKENS) : raw;
				const resultGroup = b.group(groups.toolResult, "tool-result", tool);
				const label = typeof m.content === "string" ? firstLine(m.content) : firstLine(textOf(m.content));
				b.leaf(b.group(groups.toolResultFor(name), name, resultGroup), leafId.toolResult(m.toolCallId ?? ""), label, raw, effective);
				break;
			}
			case "custom":
			case "bashExecution":
			case "branchSummary":
			case "compactionSummary": {
				meta ??= b.group(groups.meta, "meta", null);
				const raw = estimateMeta(m);
				const masked = state.anyMasked(chains.meta(m));
				b.leaf(b.group(groups.metaFor(m.role), m.role, meta), leafId.meta(m), metaLabel(m), raw, masked ? 0 : raw);
				break;
			}
		}
	}

	// Group counts show occurrences; top-level role groups show message counts
	// (matching the reference UI where "assistant 330x" is messages while
	// "tool-call 179x" is blocks).
	assistant.count = assistantMessages;
	user.count = userMessages;
	tool.count = toolMessages;

	// Largest-first ordering inside tool-call / tool-result groupings.
	for (const id of [groups.toolCall, groups.toolResult]) {
		const node = b.roots.flatMap((r) => r.children).find((c) => c.id === id);
		node?.children.sort((a, z) => z.rawTokens - a.rawTokens);
	}

	const roots = b.roots.filter((r) => r.count > 0 || r.children.length > 0);
	const rawTotal = roots.reduce((sum, r) => sum + r.rawTokens, 0);
	const effectiveTotal = roots.reduce((sum, r) => sum + r.effectiveTokens, 0);
	return { roots, messageCount: messages.length, rawTotal, effectiveTotal };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block?.type === "text" && block.text) return block.text;
	}
	return "";
}

function estimateMeta(m: AnyMessage): number {
	if (m.role === "bashExecution") {
		return Math.ceil(((String((m as any).command ?? "") + String((m as any).output ?? "")).length) / 4);
	}
	if (m.role === "branchSummary" || m.role === "compactionSummary") {
		return Math.ceil(String((m as any).summary ?? "").length / 4);
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
