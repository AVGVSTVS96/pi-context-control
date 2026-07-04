/**
 * The two tree models the panel can show, built from the same leaf index:
 *
 *  - buildTree:        general view — role → content-type → tool → messages
 *  - buildSessionTree: session view — turn → items in order, with each tool
 *                      call and its result merged into one "pair" row
 *
 * "raw" is what an item costs as recorded; "effective" is what it will cost
 * after the current mask set is applied (0 when dropped, the exact stub cost
 * when a tool result is stubbed). Leaves carry their covering chain so mask
 * toggling works identically from either view.
 */

import { groups, pairId } from "./keys.ts";
import { droppedCallIds, type LeafIndex, type LeafInfo, type LeafKind, leafEffective } from "./leaves.ts";
import type { MaskState } from "./masking.ts";
import { type SummaryRecord, summaryLabel, summaryNodeId, summaryTokens } from "./summaries.ts";

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
	/** Own id masked directly (vs inherited/covered). */
	selfMasked: boolean;
	/** Effectively masked (own id or anything covering it). */
	masked: boolean;
	/** Leaves: full covering chain for mask toggling. */
	chain?: readonly string[];
	/** Leaves: what kind of content this is (drives per-view affordances). */
	kind?: LeafKind;
}

/**
 * Span coverage shared by both builders: which leaves each APPLIED summary
 * replaces (they render at 0 effective), and where each record's synthetic
 * node sits (at its first covered leaf). Pending and inactive records get a
 * row too — "generating…" and a dimmed re-appliable summary — but cover
 * nothing until applied.
 */
function summaryCoverage(idx: LeafIndex, records: readonly SummaryRecord[]) {
	const applied = new Set<string>();
	const nodeAt = new Map<string, SummaryRecord[]>();
	const placed = new Set<string>();
	const byLeaf = new Map<string, SummaryRecord[]>();
	for (const r of records) {
		for (const id of r.leafIds) {
			const list = byLeaf.get(id) ?? [];
			list.push(r);
			byLeaf.set(id, list);
		}
	}
	for (const leaf of idx.leaves) {
		const rs = byLeaf.get(leaf.id);
		if (!rs) continue;
		if (rs.some((r) => r.active && !r.pending)) applied.add(leaf.id);
		for (const r of rs) {
			if (placed.has(r.id)) continue;
			placed.add(r.id);
			const at = nodeAt.get(leaf.id) ?? [];
			at.push(r);
			nodeAt.set(leaf.id, at);
		}
	}
	return { applied, nodeAt };
}

/** Synthetic row standing in for a summarized span. raw is 0: restoring it removes the digest. */
function summaryLeaf(record: SummaryRecord, turnId: string): { info: LeafInfo; effective: number; masked: boolean } {
	const id = summaryNodeId(record);
	const appliedNow = record.active && !record.pending;
	return {
		info: {
			id,
			kind: "summary",
			chain: [id],
			turnId,
			label: summaryLabel(record),
			raw: 0,
			timestamp: record.createdAt,
		},
		effective: appliedNow ? summaryTokens(record) : 0,
		// Inactive = switched off: render like masked content so it reads as
		// "here, but not sent" and space can switch it back on.
		masked: !record.active && !record.pending,
	};
}

export interface ContextTreeModel {
	roots: TreeNode[];
	messageCount: number;
	rawTotal: number;
	effectiveTotal: number;
}

class TreeBuilder {
	private nodes = new Map<string, TreeNode>();
	private state: MaskState;
	roots: TreeNode[] = [];

	constructor(state: MaskState) {
		this.state = state;
	}

	get(id: string): TreeNode | undefined {
		return this.nodes.get(id);
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

	leaf(parent: TreeNode, leaf: LeafInfo, effective: number, label?: string, forceMasked = false): void {
		const node: TreeNode = {
			id: leaf.id,
			label: label ?? leaf.label,
			count: 1,
			rawTokens: leaf.raw,
			effectiveTokens: effective,
			children: [],
			parent,
			isLeaf: true,
			selfMasked: this.state.has(leaf.id),
			masked: forceMasked || this.state.anyMasked(leaf.chain),
			chain: leaf.chain,
			kind: leaf.kind,
		};
		parent.children.push(node);
		// Propagate tokens and counts up the group chain.
		for (let p: TreeNode | null = parent; p; p = p.parent) {
			p.count += 1;
			p.rawTokens += leaf.raw;
			p.effectiveTokens += effective;
		}
	}

	finish(messageCount: number): ContextTreeModel {
		const roots = this.roots.filter((r) => r.count > 0 || r.children.length > 0);
		return {
			roots,
			messageCount,
			rawTotal: roots.reduce((sum, r) => sum + r.rawTokens, 0),
			effectiveTotal: roots.reduce((sum, r) => sum + r.effectiveTokens, 0),
		};
	}
}

/** General view: role → content-type → tool. */
export function buildTree(idx: LeafIndex, state: MaskState, summaries: readonly SummaryRecord[] = []): ContextTreeModel {
	const b = new TreeBuilder(state);
	const droppedCalls = droppedCallIds(idx, state);
	const { applied, nodeAt } = summaryCoverage(idx, summaries);

	const assistant = b.group(groups.assistant, "assistant", null);
	const user = b.group(groups.user, "user", null);
	const tool = b.group(groups.tool, "tool", null);

	for (const leaf of idx.leaves) {
		for (const record of nodeAt.get(leaf.id) ?? []) {
			const sum = summaryLeaf(record, leaf.turnId);
			const group = b.group(groups.metaFor("summary"), "summary", b.group(groups.meta, "meta", null));
			b.leaf(group, sum.info, sum.effective, undefined, sum.masked);
		}
		const effective = applied.has(leaf.id) ? 0 : leafEffective(leaf, state, droppedCalls);
		switch (leaf.kind) {
			case "assistant-text":
				b.leaf(b.group(groups.assistantText, "text", assistant), leaf, effective);
				break;
			case "reasoning":
				b.leaf(b.group(groups.reasoning, "reasoning", assistant), leaf, effective);
				break;
			case "tool-call": {
				const callGroup = b.group(groups.toolCall, "tool-call", assistant);
				b.leaf(b.group(groups.toolCallFor(leaf.tool ?? "unknown"), leaf.tool ?? "unknown", callGroup), leaf, effective);
				break;
			}
			case "user-text":
				b.leaf(b.group(groups.userText, "text", user), leaf, effective);
				break;
			case "user-image":
				b.leaf(b.group(groups.userImage, "image", user), leaf, effective);
				break;
			case "tool-result": {
				const resultGroup = b.group(groups.toolResult, "tool-result", tool);
				b.leaf(
					b.group(groups.toolResultFor(leaf.tool ?? "unknown"), leaf.tool ?? "unknown", resultGroup),
					leaf,
					effective,
				);
				break;
			}
			case "meta": {
				const meta = b.group(groups.meta, "meta", null);
				const role = leaf.metaRole ?? "meta";
				b.leaf(b.group(groups.metaFor(role), role, meta), leaf, effective);
				break;
			}
		}
	}

	// Top-level role groups show message counts (matching the reference UI
	// where "assistant 330x" is messages while "tool-call 179x" is blocks).
	assistant.count = idx.roleCounts.assistant;
	user.count = idx.roleCounts.user;
	tool.count = idx.roleCounts.tool;

	// Largest-first ordering inside tool-call / tool-result groupings.
	for (const id of [groups.toolCall, groups.toolResult]) {
		b.get(id)?.children.sort((a, z) => z.rawTokens - a.rawTokens);
	}

	return b.finish(idx.messageCount);
}

/** Session view: turn → items in chronological order, call+result paired. */
export function buildSessionTree(
	idx: LeafIndex,
	state: MaskState,
	summaries: readonly SummaryRecord[] = [],
): ContextTreeModel {
	const b = new TreeBuilder(state);
	const droppedCalls = droppedCallIds(idx, state);
	const { applied, nodeAt } = summaryCoverage(idx, summaries);
	const turnLabels = new Map(idx.turns.map((t, i) => [t.id, `turn ${i + 1} · ${t.label}`]));

	for (const leaf of idx.leaves) {
		const effective = applied.has(leaf.id) ? 0 : leafEffective(leaf, state, droppedCalls);
		const turn = b.group(leaf.turnId, turnLabels.get(leaf.turnId) ?? leaf.turnId, null);
		for (const record of nodeAt.get(leaf.id) ?? []) {
			const sum = summaryLeaf(record, leaf.turnId);
			b.leaf(turn, sum.info, sum.effective, undefined, sum.masked);
		}
		switch (leaf.kind) {
			case "user-text":
				b.leaf(turn, leaf, effective, `user · ${leaf.label}`);
				break;
			case "user-image":
				b.leaf(turn, leaf, effective, `user · ${leaf.label}`);
				break;
			case "assistant-text":
				b.leaf(turn, leaf, effective, `assistant · ${leaf.label}`);
				break;
			case "reasoning":
				b.leaf(turn, leaf, effective, `reasoning · ${leaf.label}`);
				break;
			case "tool-call": {
				const pair = b.group(pairId(leaf.toolCallId ?? ""), `${leaf.tool} · ${leaf.label}`, turn);
				b.leaf(pair, leaf, effective, "call");
				break;
			}
			case "tool-result": {
				const pair = b.group(pairId(leaf.toolCallId ?? ""), `${leaf.tool} · result`, turn);
				b.leaf(pair, leaf, effective, `result · ${leaf.label}`);
				break;
			}
			case "meta":
				b.leaf(turn, leaf, effective, `${leaf.metaRole} · ${leaf.label}`);
				break;
		}
	}

	// Turn rows count messages; pair rows are one exchange, not two blocks.
	const turnCounts = new Map(idx.turns.map((t) => [t.id, t.messageCount]));
	for (const turn of b.roots) {
		turn.count = turnCounts.get(turn.id) ?? turn.count;
		for (const child of turn.children) {
			if (!child.isLeaf) child.count = 1;
		}
	}

	return b.finish(idx.messageCount);
}
