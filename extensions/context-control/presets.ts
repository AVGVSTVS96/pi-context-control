/**
 * Mask presets, applied from the panel ("p").
 *
 * Presets are one-shot batches rather than live rules: a rule that re-masks
 * on every turn would move the cache-break point every call, while a batch
 * applied once breaks the prompt cache once. Rule-based presets mask
 * individual leaves, so items that arrive later stay visible and anything
 * can still be unmasked by hand.
 *
 * Built-ins with a ‹value› are tunable in the menu (←/→ or digits); users can
 * add their own combinations via a `context-control.json` config file.
 */

import { formatCompact } from "./estimate.ts";
import { groups } from "./keys.ts";
import type { LeafIndex, LeafKind } from "./leaves.ts";
import type { MaskState } from "./masking.ts";

export interface PresetParam {
	kind: "turns" | "tokens";
	min: number;
	max: number;
	step: number;
}

export interface Preset {
	id: string;
	label: (value?: number) => string;
	param?: PresetParam;
	defaultValue?: number;
	/** Mutates the mask state; returns the number of changes made. */
	apply: (state: MaskState, idx: LeafIndex, value?: number) => number;
}

/** What a rule-based preset matches. All conditions are ANDed. */
export interface PresetRule {
	/** Leaf kinds to mask. Defaults to tool results. */
	types?: LeafKind[];
	/** Restrict to specific tools (read, bash, …). */
	tools?: string[];
	/** Only items in turns before the Nth-from-last turn. */
	olderThanTurns?: number;
	/** Only items at least this many (estimated) tokens. */
	largerThanTokens?: number;
}

export function applyRule(state: MaskState, idx: LeafIndex, rule: PresetRule): number {
	const types = new Set<LeafKind>(rule.types ?? ["tool-result"]);
	let cutoff = Number.POSITIVE_INFINITY;
	if (rule.olderThanTurns != null) {
		cutoff = idx.turns.length - rule.olderThanTurns;
		if (cutoff <= 0) return 0;
	}
	const turnPos = new Map(idx.turns.map((t, i) => [t.id, i]));

	let changes = 0;
	for (const leaf of idx.leaves) {
		if (!types.has(leaf.kind)) continue;
		if (rule.tools && (!leaf.tool || !rule.tools.includes(leaf.tool))) continue;
		if (rule.olderThanTurns != null && (turnPos.get(leaf.turnId) ?? 0) >= cutoff) continue;
		if (rule.largerThanTokens != null && leaf.raw < rule.largerThanTokens) continue;
		if (state.anyMasked(leaf.chain)) continue;
		state.add(leaf.id);
		changes++;
	}
	return changes;
}

function maskGroup(id: string) {
	return (state: MaskState): number => {
		if (state.has(id)) return 0;
		state.add(id);
		return 1;
	};
}

export const PRESETS: Preset[] = [
	{
		id: "stale-results",
		label: (v) => `Hide tool results older than ‹${v ?? 2}› turns`,
		param: { kind: "turns", min: 1, max: 50, step: 1 },
		defaultValue: 2,
		apply: (state, idx, v) => applyRule(state, idx, { types: ["tool-result"], olderThanTurns: v ?? 2 }),
	},
	{
		id: "big-results",
		label: (v) => `Hide tool results larger than ‹${formatCompact(v ?? 2000)}› tokens`,
		param: { kind: "tokens", min: 500, max: 100_000, step: 500 },
		defaultValue: 2000,
		apply: (state, idx, v) => applyRule(state, idx, { types: ["tool-result"], largerThanTokens: v ?? 2000 }),
	},
	{
		id: "all-results",
		label: () => "Hide all tool results",
		apply: maskGroup(groups.toolResult),
	},
	{
		id: "all-reasoning",
		label: () => "Hide all reasoning",
		apply: maskGroup(groups.reasoning),
	},
	{
		id: "clear",
		label: () => "Clear all masks",
		apply: (state) => {
			const changes = state.size;
			state.load([]);
			return changes;
		},
	},
];

/** Shape of one user-defined preset in context-control.json. */
export interface UserPresetConfig extends PresetRule {
	label: string;
}

export function toPreset(cfg: UserPresetConfig, index: number): Preset {
	return {
		id: `user:${index}:${cfg.label}`,
		label: () => cfg.label,
		apply: (state, idx) => applyRule(state, idx, cfg),
	};
}
