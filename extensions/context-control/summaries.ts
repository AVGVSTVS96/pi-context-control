/**
 * Non-destructive span summarization.
 *
 * A span is whatever contiguous slice of the session view the user selected:
 * one turn, several turns, or a run of items inside a turn. An LLM call
 * distills the span into a compact digest; from then on the `context` event
 * drops the span's leaves and injects the digest at their position. The
 * session file never changes: restoring is just not applying the swap, and
 * the generated text is kept so re-applying never re-calls the LLM (history
 * is immutable, so a span's summary can never go stale).
 *
 * Pairing safety mirrors masking: spans always cover whole call/result pairs,
 * so dropping a span never leaves a tool call without its result.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { estimateChars } from "./estimate.ts";
import { type AnyMessage, leafId } from "./keys.ts";
import type { LeafIndex } from "./leaves.ts";
import type { MaskableNode } from "./masking.ts";
import { firstLine } from "./summarize.ts";

export interface SummaryRecord {
	id: string;
	/** Leaf ids the summary replaces, in chronological order. */
	leafIds: string[];
	/** The generated digest ("" while still generating). */
	text: string;
	/** provider/model that produced it. */
	model: string;
	/** Applied at context time; false = originals restored (text kept for free re-apply). */
	active: boolean;
	/** Generation in flight: shown in the tree but not applied yet. Not persisted. */
	pending?: boolean;
	createdAt: number;
}

/** Tree/stream id of the synthetic node standing in for a record's span. */
export function summaryNodeId(record: SummaryRecord): string {
	return `sum:${record.id}`;
}

/** The full injected message text (framing included), so estimates match what is sent. */
export function summaryText(record: SummaryRecord): string {
	return `[Earlier context was replaced by this summary (context-control). Ask the user to restore the originals if you need them.]\n${record.text}`;
}

export function summaryTokens(record: SummaryRecord): number {
	return record.pending ? 0 : estimateChars(summaryText(record));
}

/** Records that actually take effect: active, generated, and whole span still present. */
export function applicableRecords(records: readonly SummaryRecord[], idx: LeafIndex): SummaryRecord[] {
	const present = new Set(idx.leaves.map((l) => l.id));
	return records.filter((r) => r.active && !r.pending && r.leafIds.every((id) => present.has(id)));
}

export class SummaryStore {
	private records: SummaryRecord[] = [];

	get all(): readonly SummaryRecord[] {
		return this.records;
	}

	get(id: string): SummaryRecord | undefined {
		return this.records.find((r) => r.id === id);
	}

	add(record: SummaryRecord): void {
		this.records.push(record);
	}

	remove(id: string): void {
		this.records = this.records.filter((r) => r.id !== id);
	}

	applicable(idx: LeafIndex): SummaryRecord[] {
		return applicableRecords(this.records, idx);
	}

	/**
	 * Records the tree should show: in-flight ones, and every record whose
	 * span still exists, including inactive (restored) ones, which render as
	 * a dimmed row so a summary is never lost by toggling it off.
	 */
	visible(idx: LeafIndex): SummaryRecord[] {
		const present = new Set(idx.leaves.map((l) => l.id));
		return this.records.filter((r) => r.pending || r.leafIds.every((id) => present.has(id)));
	}

	/** An existing record covering exactly this span (order-insensitive). */
	findBySpan(leafIds: readonly string[]): SummaryRecord | undefined {
		const want = new Set(leafIds);
		return this.records.find((r) => r.leafIds.length === want.size && r.leafIds.every((id) => want.has(id)));
	}

	/** Drop records sharing any leaf with the given span (a re-summarize replaces them). */
	removeOverlapping(leafIds: readonly string[], exceptId?: string): number {
		const span = new Set(leafIds);
		const before = this.records.length;
		this.records = this.records.filter((r) => r.id === exceptId || !r.leafIds.some((id) => span.has(id)));
		return before - this.records.length;
	}

	/** Drop records whose span no longer fully exists (e.g. after pi compaction). */
	prune(idx: LeafIndex): number {
		const present = new Set(idx.leaves.map((l) => l.id));
		const before = this.records.length;
		this.records = this.records.filter((r) => r.pending || r.leafIds.every((id) => present.has(id)));
		return before - this.records.length;
	}

	toJSON(): SummaryRecord[] {
		return this.records.filter((r) => !r.pending).map(({ pending: _p, ...rest }) => ({ ...rest }));
	}

	load(saved: readonly SummaryRecord[] | undefined): void {
		this.records = (saved ?? [])
			.filter((r) => r && typeof r.text === "string" && Array.isArray(r.leafIds))
			.map((r) => ({ ...r, pending: false }));
	}
}

/**
 * Leaf ids covered by a range of tree nodes, whole pairs enforced: a tool
 * call pulls in its result and vice versa (an unpaired call or result would
 * be rejected by providers). Summary rows inside the range are transparent:
 * a span always addresses the original leaves, and re-summarizing simply
 * replaces the old record on completion.
 */
export function spanLeafIds(nodes: readonly MaskableNode[]): string[] {
	const ids = new Set<string>();
	const visit = (node: MaskableNode) => {
		if (node.id.startsWith("sum:")) return;
		if (node.isLeaf) {
			ids.add(node.id);
			if (node.id.startsWith("call:")) ids.add(`result:${node.id.slice(5)}`);
			else if (node.id.startsWith("result:")) ids.add(`call:${node.id.slice(7)}`);
			return;
		}
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return [...ids];
}

/** Restrict + order a span to leaves that exist, chronologically. */
export function canonicalSpan(leafIds: readonly string[], idx: LeafIndex): string[] {
	const want = new Set(leafIds);
	return idx.leaves.filter((l) => want.has(l.id)).map((l) => l.id);
}

/** Leaf ids of one message's blocks, in block order (mirrors indexLeaves). */
function messageLeafIds(m: AnyMessage): string[] {
	switch (m.role) {
		case "assistant": {
			const ids: string[] = [];
			const content = Array.isArray(m.content) ? m.content : [];
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text") ids.push(leafId.assistantText(m));
				else if (block.type === "thinking") ids.push(leafId.reasoning(m));
				else if (block.type === "toolCall") ids.push(leafId.toolCall(block.id ?? ""));
			}
			return ids;
		}
		case "toolResult":
			return [leafId.toolResult(m.toolCallId ?? "")];
		case "user":
			return [leafId.userText(m), leafId.userImage(m)];
		case "custom":
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return [leafId.meta(m)];
		default:
			return [];
	}
}

function blockLeafId(m: AnyMessage, block: { type?: string; id?: string }): string | undefined {
	if (m.role === "assistant") {
		if (block.type === "text") return leafId.assistantText(m);
		if (block.type === "thinking") return leafId.reasoning(m);
		if (block.type === "toolCall") return leafId.toolCall(block.id ?? "");
	}
	if (m.role === "user") {
		if (block.type === "text") return leafId.userText(m);
		if (block.type === "image") return leafId.userImage(m);
	}
	return undefined;
}

/**
 * The context transform: drop each record's leaves and inject its digest
 * (one user message) where the span began. Runs after applyMask, so leaves
 * already masked away simply aren't here to drop; the digest lands before
 * the first covered leaf that survived.
 */
export function applySummaries(messages: AnyMessage[], records: readonly SummaryRecord[]): AnyMessage[] {
	if (records.length === 0) return messages;
	const covered = new Map<string, SummaryRecord>();
	for (const r of records) for (const id of r.leafIds) covered.set(id, r);
	const injected = new Set<string>();
	const out: AnyMessage[] = [];

	const inject = (record: SummaryRecord) => {
		if (injected.has(record.id)) return;
		injected.add(record.id);
		out.push({
			role: "user",
			content: [{ type: "text", text: summaryText(record) }],
			timestamp: record.createdAt,
		});
	};

	for (const m of messages) {
		switch (m.role) {
			case "assistant": {
				const content = Array.isArray(m.content) ? m.content : [];
				const kept: unknown[] = [];
				let changed = false;
				for (const block of content) {
					const id = block && typeof block === "object" ? blockLeafId(m, block) : undefined;
					const record = id ? covered.get(id) : undefined;
					if (record) {
						inject(record);
						changed = true;
						continue;
					}
					kept.push(block);
				}
				if (!changed) out.push(m);
				else if (kept.length > 0) out.push({ ...m, content: kept });
				break;
			}
			case "toolResult": {
				// The paired call is always covered with the result, so a covered
				// result drops whether the record listed it via call or result id.
				const record =
					covered.get(leafId.toolResult(m.toolCallId ?? "")) ?? covered.get(leafId.toolCall(m.toolCallId ?? ""));
				if (record) inject(record);
				else out.push(m);
				break;
			}
			case "user": {
				if (typeof m.content === "string") {
					const record = covered.get(leafId.userText(m));
					if (record) inject(record);
					else out.push(m);
					break;
				}
				if (!Array.isArray(m.content)) {
					out.push(m);
					break;
				}
				const kept = m.content.filter((block: { type?: string }) => {
					const id = block && typeof block === "object" ? blockLeafId(m, block) : undefined;
					const record = id ? covered.get(id) : undefined;
					if (record) inject(record);
					return !record;
				});
				if (kept.length === m.content.length) out.push(m);
				else if (kept.length > 0) out.push({ ...m, content: kept });
				break;
			}
			case "custom":
			case "bashExecution":
			case "branchSummary":
			case "compactionSummary": {
				const record = covered.get(leafId.meta(m));
				if (record) inject(record);
				else out.push(m);
				break;
			}
			default:
				out.push(m);
		}
	}
	return out;
}

/** The span's messages only (covered blocks kept, everything else stripped): the generation input. */
export function spanMessages(messages: AnyMessage[], span: ReadonlySet<string>): AnyMessage[] {
	const out: AnyMessage[] = [];
	for (const m of messages) {
		switch (m.role) {
			case "assistant":
			case "user": {
				const content = Array.isArray(m.content) ? m.content : undefined;
				if (!content) {
					if (messageLeafIds(m).some((id) => span.has(id))) out.push(m);
					break;
				}
				const kept = content.filter((block: { type?: string }) => {
					const id = block && typeof block === "object" ? blockLeafId(m, block) : undefined;
					return id !== undefined && span.has(id);
				});
				if (kept.length > 0) out.push({ ...m, content: kept });
				break;
			}
			default: {
				if (messageLeafIds(m).some((id) => span.has(id))) out.push(m);
				break;
			}
		}
	}
	return out;
}

const SPAN_SYSTEM_PROMPT =
	"You are a context compression assistant. You read an excerpt from a conversation between a user and an AI coding agent, and produce a compact digest that will replace the excerpt in the agent's context. Do NOT continue the conversation or respond to anything in it. ONLY output the digest.";

const SPAN_PROMPT = `The excerpt above is a contiguous slice of a longer conversation; the rest of the conversation stays intact around your digest. Preserve exactly what a future turn might need and drop everything else.

Keep:
- exact file paths, symbol names, commands, and error messages
- what was decided, and why
- what was tried and ruled out, so it is not retried
- facts discovered from tool output that are recorded nowhere else

Drop: pleasantries, tool mechanics, step-by-step narration, and detail that no longer matters.

Write compact prose or tight bullets, in the third person, with no preamble.`;

export interface SpanCompletionAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Distill a span's messages via one LLM call. `complete` is injectable for tests. */
export async function generateSpanSummary(
	span: AnyMessage[],
	model: Parameters<typeof completeSimple>[0],
	auth: SpanCompletionAuth,
	signal?: AbortSignal,
	complete: typeof completeSimple = completeSimple,
): Promise<string> {
	const conversation = serializeConversation(convertToLlm(span as never));
	const prompt = `<conversation-excerpt>\n${conversation}\n</conversation-excerpt>\n\n${SPAN_PROMPT}`;
	const response = await complete(
		model,
		{
			systemPrompt: SPAN_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: Math.min(2048, model.maxTokens > 0 ? model.maxTokens : 2048),
			signal,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `summarization ${response.stopReason}`);
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("summarizer returned no text");
	return text;
}

/** "provider/model-id" → registry lookup parts (first slash splits; ids may contain more). */
export function parseModelSpec(spec: string): { provider: string; id: string } | undefined {
	const i = spec.indexOf("/");
	if (i <= 0 || i >= spec.length - 1) return undefined;
	return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

/** Short label for the tree row: "summary · <how the digest begins>". */
export function summaryLabel(record: SummaryRecord): string {
	return record.pending ? "summary · generating…" : `summary · ${firstLine(record.text)}`;
}
