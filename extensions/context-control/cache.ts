/**
 * Cache awareness — what masking does to the prompt cache.
 *
 * Prompt caching is prefix-based: the provider caches the prompt exactly as
 * sent on the last call, and the next call reuses the longest unchanged
 * prefix. Any edit (masking or unmasking) rewrites everything after the edit
 * point: those tokens are written to cache once more (~1.25x base price),
 * after which the smaller prompt reads from cache again (~0.1x) on every
 * later call. So masking near the tail is nearly free, while masking early
 * content pays a large one-time rewrite for a small per-call saving.
 *
 * We snapshot the outgoing leaf stream on every `context` event — that is
 * precisely what the provider cached — and diff the would-send stream
 * against it to find the earliest break point, price pending changes, and
 * preview the marginal impact of toggling any node.
 */

import { droppedCallIds, type LeafIndex } from "./leaves.ts";
import { type MaskableNode, MaskState, toggleNodeMask } from "./masking.ts";

/** Anthropic pricing multipliers relative to base input tokens. */
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/** The ordered leaf stream as actually sent (masked leaves dropped/stubbed). */
export interface SentStream {
	ids: string[];
	tokens: number[];
	/** 1 when the leaf went out as a stub, 0 raw. A stub can cost the same
	 *  tokens as a tiny result while still being different bytes — and
	 *  different bytes is what breaks the cache. */
	stubbed: number[];
	total: number;
}

export interface SentSnapshot extends SentStream {
	/** Real prompt size (input + cacheRead + cacheWrite) for this call, once known. */
	actualPrompt?: number;
}

/** Mirror of applyMask: which leaves go out, and at what (estimated) size. */
export function sentStream(idx: LeafIndex, state: MaskState): SentStream {
	const dropped = droppedCallIds(idx, state);
	const ids: string[] = [];
	const tokens: number[] = [];
	const stubbed: number[] = [];
	let total = 0;
	for (const leaf of idx.leaves) {
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
 * content is not a break — that suffix is written to cache regardless. Only
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

export interface ToggleImpact {
	/** Tokens this toggle saves on every future call (>0) or adds back (<0). */
	deltaPerCall: number;
	/** Cached tokens newly invalidated by this toggle, beyond already-pending changes. */
	extraBrokenTokens: number;
	/** Cached tokens newly re-written next call, beyond already-pending changes. */
	extraRewrittenTokens: number;
	/** Calls until the one-time rewrite cost is repaid by the per-call saving. */
	paybackCalls?: number;
	/** False until a call has happened (nothing cached — every change is free). */
	hasCache: boolean;
}

/** Preview a toggle without touching real state: clone, toggle, diff both streams. */
export function toggleImpact(
	node: MaskableNode,
	idx: LeafIndex,
	state: MaskState,
	snap: SentSnapshot | undefined,
): ToggleImpact {
	const sim = new MaskState();
	sim.load(state.toJSON());
	toggleNodeMask(sim, node, idx.leaves);

	const before = sentStream(idx, state);
	const after = sentStream(idx, sim);
	const baseline = diffAgainstSnapshot(before, snap);
	const toggled = diffAgainstSnapshot(after, snap);

	const deltaPerCall = before.total - after.total;
	const extraBrokenTokens = Math.max(0, toggled.brokenTokens - baseline.brokenTokens);
	const extraRewrittenTokens = Math.max(0, toggled.rewrittenTokens - baseline.rewrittenTokens);

	// One-time cost: rewritten tokens cost a write (1.25x) instead of a read
	// (0.1x). Recurring gain: masked tokens stop costing a read every call.
	let paybackCalls: number | undefined;
	if (deltaPerCall > 0) {
		const breakCost = extraRewrittenTokens * (CACHE_WRITE_MULT - CACHE_READ_MULT);
		paybackCalls = Math.ceil(breakCost / (deltaPerCall * CACHE_READ_MULT));
	}

	return {
		deltaPerCall,
		extraBrokenTokens,
		extraRewrittenTokens,
		paybackCalls,
		hasCache: (snap?.ids.length ?? 0) > 0,
	};
}
