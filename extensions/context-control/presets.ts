/**
 * One-shot mask presets, applied from the panel ("p").
 *
 * Presets are deliberately one-shot rather than live rules: a rule that
 * re-masks on every turn would move the cache-break point every call, while a
 * batch applied once breaks the prompt cache once. "Older than N turns" masks
 * individual result leaves, so results that arrive later stay visible and any
 * single result can still be unmasked by hand.
 */

import { type AnyMessage, groups, leafId } from "./keys.ts";
import { chains, type MaskState } from "./masking.ts";

export interface Preset {
	id: string;
	label: string;
	/** Mutates the mask state; returns the number of changes made. */
	apply: (state: MaskState, messages: AnyMessage[]) => number;
}

/** Turns are counted by user messages; "older than N" means before the Nth-last one. */
function maskToolResultsOlderThan(turns: number) {
	return (state: MaskState, messages: AnyMessage[]): number => {
		const userTimes = messages.filter((m) => m.role === "user").map((m) => m.timestamp ?? 0);
		if (userTimes.length < turns) return 0;
		const boundary = userTimes[userTimes.length - turns];
		let changes = 0;
		for (const m of messages) {
			if (m.role !== "toolResult" || !m.toolCallId) continue;
			if ((m.timestamp ?? 0) >= boundary) continue;
			if (state.anyMasked(chains.toolResult(m))) continue;
			state.add(leafId.toolResult(m.toolCallId));
			changes++;
		}
		return changes;
	};
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
		id: "stale-results-2",
		label: "Hide tool results older than 2 turns",
		apply: maskToolResultsOlderThan(2),
	},
	{
		id: "stale-results-5",
		label: "Hide tool results older than 5 turns",
		apply: maskToolResultsOlderThan(5),
	},
	{
		id: "all-results",
		label: "Hide all tool results",
		apply: maskGroup(groups.toolResult),
	},
	{
		id: "all-reasoning",
		label: "Hide all reasoning",
		apply: maskGroup(groups.reasoning),
	},
	{
		id: "clear",
		label: "Clear all masks",
		apply: (state) => {
			const changes = state.size;
			state.load([]);
			return changes;
		},
	},
];
