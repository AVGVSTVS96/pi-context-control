/**
 * Cache awareness: what masking does to the prompt cache.
 *
 * Prompt caching is prefix-based: the provider caches the prompt exactly as
 * sent on the last call, and the next call reuses the longest unchanged
 * prefix. Any edit (masking or unmasking) rewrites everything after the edit
 * point: those tokens are written to cache once more (at the model's cache
 * write rate), after which the smaller prompt reads from cache again on
 * every later call. So masking near the tail is nearly free, while masking
 * early content pays a large one-time rewrite for a small per-call saving.
 *
 * We snapshot the outgoing leaf stream on every `context` event (that is
 * precisely what the provider cached) and diff the would-send stream
 * against it to find the earliest break point, price pending changes, and
 * preview the marginal impact of any plan edit (editImpact).
 */

import { droppedCallIds, type LeafIndex } from "./leaves.ts";
import { clonePlan, type PlanEdit, type SendPlan } from "./plan.ts";
import { applicableRecords, type SummaryRecord, summaryNodeId, summaryTokens } from "./summaries.ts";

/** Cache pricing relative to plain input tokens, from the model's cost table. */
export interface CacheCosts {
	writeMult: number;
	readMult: number;
}

/** Fallback when the model doesn't price caching (Anthropic-style rates). */
export const DEFAULT_CACHE_COSTS: CacheCosts = { writeMult: 1.25, readMult: 0.1 };

/**
 * Derive multipliers from the active model's per-token rates. A zero
 * cacheWrite rate means the provider bills cache misses as plain input
 * (OpenAI, Gemini): a 1x write, not a free one.
 */
export function cacheCosts(model?: { cost?: { input: number; cacheRead: number; cacheWrite: number } }): CacheCosts {
	const c = model?.cost;
	if (!c || !(c.input > 0) || !(c.cacheRead > 0)) return DEFAULT_CACHE_COSTS;
	return {
		writeMult: c.cacheWrite > 0 ? c.cacheWrite / c.input : 1,
		readMult: c.cacheRead / c.input,
	};
}

/** The ordered leaf stream as actually sent (masked leaves dropped/stubbed). */
export interface SentStream {
	ids: string[];
	tokens: number[];
	/** 1 when the leaf went out as a stub, 0 raw. A stub can cost the same
	 *  tokens as a tiny result while still being different bytes, and
	 *  different bytes is what breaks the cache. */
	stubbed: number[];
	total: number;
}

export interface SentSnapshot extends SentStream {
	/** Real prompt size (input + cacheRead + cacheWrite) for this call, once known. */
	actualPrompt?: number;
}

/** Mirror of applyPlan: which items go out, and at what (estimated) size. */
export function sentStream(idx: LeafIndex, plan: SendPlan): SentStream {
	const state = plan.masks;
	const dropped = droppedCallIds(idx, state);
	const covered = new Map<string, SummaryRecord>();
	for (const r of applicableRecords(plan.summaries, idx)) for (const id of r.leafIds) covered.set(id, r);
	const injected = new Set<string>();
	const ids: string[] = [];
	const tokens: number[] = [];
	const stubbed: number[] = [];
	let total = 0;
	for (const leaf of idx.leaves) {
		// Summarized leaves don't go out; the digest goes out once, where the
		// first covered leaf that survives masking was (mirrors applySummaries).
		const record = covered.get(leaf.id);
		if (record) {
			const survives =
				leaf.kind === "tool-result"
					? !(leaf.toolCallId && dropped.has(leaf.toolCallId))
					: !state.anyMasked(leaf.chain);
			if (survives && !injected.has(record.id)) {
				injected.add(record.id);
				const t = summaryTokens(record);
				ids.push(summaryNodeId(record));
				tokens.push(t);
				stubbed.push(0);
				total += t;
			}
			continue;
		}
		let sent: number;
		let stub = 0;
		if (leaf.kind === "tool-result") {
			// Dropped with its call, stubbed when masked, raw otherwise.
			if (leaf.toolCallId && dropped.has(leaf.toolCallId)) continue;
			stub = state.anyMasked(leaf.chain) ? 1 : 0;
			sent = stub ? Math.min(leaf.raw, leaf.stubTokens ?? 0) : leaf.raw;
		} else {
			if (state.anyMasked(leaf.chain)) continue;
			sent = leaf.raw;
		}
		ids.push(leaf.id);
		tokens.push(sent);
		stubbed.push(stub);
		total += sent;
	}
	return { ids, tokens, stubbed, total };
}

export interface BreakInfo {
	/** First cached leaf whose sent form changes; undefined = clean extension, no break. */
	breakLeafId?: string;
	/** Cached tokens invalidated (the snapshot's suffix from the break point). */
	brokenTokens: number;
	/** Previously-cached tokens re-written next call (still sent, but past the break). */
	rewrittenTokens: number;
}

/**
 * Find where `current` first diverges from the cached snapshot. Appending new
 * content is not a break; that suffix is written to cache regardless. Only
 * changes within the snapshot's length invalidate cached tokens.
 */
export function diffAgainstSnapshot(current: SentStream, snap: SentSnapshot | undefined): BreakInfo {
	if (!snap || snap.ids.length === 0) return { brokenTokens: 0, rewrittenTokens: 0 };
	const shared = Math.min(snap.ids.length, current.ids.length);
	let i = 0;
	while (
		i < shared &&
		current.ids[i] === snap.ids[i] &&
		current.tokens[i] === snap.tokens[i] &&
		current.stubbed[i] === snap.stubbed[i]
	)
		i++;
	if (i >= snap.ids.length) return { brokenTokens: 0, rewrittenTokens: 0 };

	let broken = 0;
	for (let j = i; j < snap.tokens.length; j++) broken += snap.tokens[j];
	// Rewritten = cached content re-sent past the break. Genuinely new leaves
	// are excluded: they cost a cache write with or without the break.
	const cachedIds = new Set(snap.ids);
	let rewritten = 0;
	for (let j = i; j < current.ids.length; j++) {
		if (cachedIds.has(current.ids[j])) rewritten += current.tokens[j];
	}
	return { breakLeafId: snap.ids[i], brokenTokens: broken, rewrittenTokens: rewritten };
}

export interface Impact {
	/** Tokens this edit saves on every future call (>0) or adds back (<0). */
	deltaPerCall: number;
	/** Cached tokens newly invalidated by this edit, beyond already-pending changes. */
	extraBrokenTokens: number;
	/** Cached tokens newly re-written next call, beyond already-pending changes. */
	extraRewrittenTokens: number;
	/** Calls until the one-time rewrite cost is repaid by the per-call saving. */
	paybackCalls?: number;
	/** False until a call has happened (nothing cached, every change is free). */
	hasCache: boolean;
}

/**
 * Price a plan edit without committing it: run the SAME edit the keypress
 * would run against a clone, and diff both streams against the snapshot.
 */
export function editImpact(
	idx: LeafIndex,
	plan: SendPlan,
	edit: PlanEdit,
	snap: SentSnapshot | undefined,
	costs: CacheCosts = DEFAULT_CACHE_COSTS,
): Impact {
	const draft = clonePlan(plan);
	edit(draft);
	return impactFromStreams(sentStream(idx, plan), sentStream(idx, draft), snap, costs);
}

function impactFromStreams(
	before: SentStream,
	after: SentStream,
	snap: SentSnapshot | undefined,
	costs: CacheCosts,
): Impact {
	const baseline = diffAgainstSnapshot(before, snap);
	const toggled = diffAgainstSnapshot(after, snap);

	const deltaPerCall = before.total - after.total;
	const extraBrokenTokens = Math.max(0, toggled.brokenTokens - baseline.brokenTokens);
	const extraRewrittenTokens = Math.max(0, toggled.rewrittenTokens - baseline.rewrittenTokens);

	// One-time cost: rewritten tokens cost a write instead of a read.
	// Recurring gain: masked tokens stop costing a read every call.
	let paybackCalls: number | undefined;
	if (deltaPerCall > 0 && costs.readMult > 0) {
		const breakCost = extraRewrittenTokens * Math.max(0, costs.writeMult - costs.readMult);
		paybackCalls = Math.ceil(breakCost / (deltaPerCall * costs.readMult));
	}

	return {
		deltaPerCall,
		extraBrokenTokens,
		extraRewrittenTokens,
		paybackCalls,
		hasCache: (snap?.ids.length ?? 0) > 0,
	};
}
