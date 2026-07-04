/**
 * The send plan — the one object that decides what goes out on the next LLM
 * call (mask state + summary records) — and plan edits, the only way user
 * actions change it.
 *
 * Every action that changes what is sent is written ONCE as a PlanEdit and
 * used twice: run against the live plan to take effect, and run against a
 * clone to be priced against the prompt cache (cache.editImpact) before the
 * key is pressed. Because preview and action share the same edit, the cache
 * math can never drift from what a keypress actually does — a new kind of
 * edit gets cache awareness by construction.
 */

import type { AnyMessage } from "./keys.ts";
import type { LeafIndex } from "./leaves.ts";
import { applyMask, type LeafRef, MaskState, toggleNodeMask } from "./masking.ts";
import { applicableRecords, applySummaries, type SummaryRecord } from "./summaries.ts";
import type { TreeNode } from "./tree.ts";

export interface SendPlan {
	masks: MaskState;
	/** All known records; which of them apply is derived per index. */
	summaries: SummaryRecord[];
}

/**
 * One user action's effect on the plan, in place. The caller decides whether
 * the plan is live (commit) or a clone (preview) — the edit cannot tell.
 */
export type PlanEdit = (plan: SendPlan) => void;

export function sendPlan(masks: MaskState, summaries: SummaryRecord[] = []): SendPlan {
	return { masks, summaries };
}

/** Deep enough that edits on the clone never touch live state. */
export function clonePlan(plan: SendPlan): SendPlan {
	const masks = new MaskState();
	masks.load(plan.masks.toJSON());
	return { masks, summaries: plan.summaries.map((r) => ({ ...r })) };
}

/**
 * The context transform: masks first, then summary swaps. cache.sentStream
 * prices exactly this — the two must agree on ordering and coverage.
 */
export function applyPlan(messages: AnyMessage[], idx: LeafIndex, plan: SendPlan): AnyMessage[] {
	const out = applyMask(messages, plan.masks);
	const active = applicableRecords(plan.summaries, idx);
	return active.length > 0 ? applySummaries(out, active) : out;
}

/** Applied summaries anywhere under a tree node. */
function appliedSummariesUnder(node: TreeNode, summaries: readonly SummaryRecord[]): SummaryRecord[] {
	const out: SummaryRecord[] = [];
	const visit = (n: TreeNode) => {
		if (n.id.startsWith("sum:")) {
			const record = summaries.find((r) => r.id === n.id.slice(4));
			if (record?.active && !record.pending) out.push(record);
			return;
		}
		for (const child of n.children) visit(child);
	};
	visit(node);
	return out;
}

/** Any real (non-summary) content under the node hidden by masks. */
function hasMaskedContent(node: TreeNode, masks: MaskState): boolean {
	if (node.kind === "summary") return false;
	if (node.isLeaf) return masks.anyMasked(node.chain ?? [node.id]);
	return masks.has(node.id) || node.children.some((child) => hasMaskedContent(child, masks));
}

/** Switch a record on, switching off any other active record sharing a leaf. */
function activate(summaries: readonly SummaryRecord[], record: SummaryRecord): void {
	const span = new Set(record.leafIds);
	for (const other of summaries) {
		if (other !== record && other.active && other.leafIds.some((id) => span.has(id))) {
			other.active = false;
		}
	}
	record.active = true;
}

/**
 * Space on a non-summary node. Same two-state cycle as plain masking, but an
 * applied summary under the node counts as hidden content: the first press
 * brings everything back (restore summaries + clear masks), the next press
 * masks the whole node. Summaries are only switched off, never discarded.
 */
export function toggleNodeEdit(node: TreeNode, allLeaves: readonly LeafRef[]): PlanEdit {
	return (plan) => {
		const applied = appliedSummariesUnder(node, plan.summaries);
		if (applied.length > 0) {
			for (const record of applied) record.active = false;
			if (hasMaskedContent(node, plan.masks)) toggleNodeMask(plan.masks, node, allLeaves);
		} else {
			toggleNodeMask(plan.masks, node, allLeaves);
		}
	};
}

/** Space on a summary row: apply/restore the swap (generating rows are handled outside the plan). */
export function toggleSummaryEdit(recordId: string): PlanEdit {
	return (plan) => {
		const record = plan.summaries.find((r) => r.id === recordId);
		if (!record || record.pending) return;
		if (record.active) record.active = false;
		else activate(plan.summaries, record);
	};
}

/**
 * The swap a confirmed `s` selection will make, for pricing before the digest
 * exists: a draft record with empty text stands in. Break and rewrite numbers
 * are exact (the digest is new bytes either way); the per-call saving is an
 * upper bound. Preview-only — the real record is added when generation starts.
 */
export function summarizeSpanEdit(leafIds: readonly string[]): PlanEdit {
	return (plan) => {
		const draft: SummaryRecord = {
			id: "draft",
			leafIds: [...leafIds],
			text: "",
			model: "",
			active: false,
			createdAt: 0,
		};
		plan.summaries.push(draft);
		activate(plan.summaries, draft);
	};
}
