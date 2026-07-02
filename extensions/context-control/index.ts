/**
 * pi-context-control — interactive context window manager for pi.
 *
 * /ctx opens a panel showing everything in the current LLM context with token
 * estimates, in two views ("v" toggles): general (role → type → tool) and
 * session (turn → items in order). Any node can be masked out of context.
 *
 * Masking is applied on the `context` event before every LLM call and never
 * modifies the session file — everything is reversible.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { cacheCosts, diffAgainstSnapshot, type SentSnapshot, sentStream, toggleImpact } from "./cache.ts";
import { formatCompact } from "./estimate.ts";
import type { AnyMessage } from "./keys.ts";
import { indexLeaves, type LeafIndex, maskedLeafCount, pruneStaleMasks } from "./leaves.ts";
import { applyMask, MaskState, toggleNodeMask } from "./masking.ts";
import { type CacheStatus, ContextPanel, type ViewMode } from "./panel.ts";
import { type Preset, PRESETS, toPreset, type UserPresetConfig } from "./presets.ts";
import { buildSessionTree, buildTree, type ContextTreeModel } from "./tree.ts";

const CUSTOM_TYPE = "context-control";
const PANEL_KEY = "context-control:panel";

interface PersistedState {
	masked?: string[];
	presetValues?: Record<string, number>;
}

/** User-defined presets from .pi/context-control.json (project) and ~/.pi/context-control.json. */
function loadUserPresets(cwd: string): Preset[] {
	const presets: Preset[] = [];
	for (const file of [join(homedir(), ".pi", "context-control.json"), join(cwd, ".pi", "context-control.json")]) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { presets?: UserPresetConfig[] };
			for (const cfg of parsed.presets ?? []) {
				if (typeof cfg?.label === "string") presets.push(toPreset(cfg, presets.length));
			}
		} catch {
			// Malformed config: skip silently rather than break the session.
		}
	}
	return presets;
}

export default function contextControl(pi: ExtensionAPI): void {
	const state = new MaskState();
	let presetValues: Record<string, number> = {};
	let allPresets: Preset[] = PRESETS;
	let panel: ContextPanel | undefined;
	let panelFocused = false;
	let closePanel: (() => void) | undefined;
	/** What the last LLM call actually sent (post-mask) — i.e. what is cached. */
	let lastSent: SentSnapshot | undefined;

	function contextMessages(ctx: ExtensionContext): AnyMessage[] {
		const sm = ctx.sessionManager;
		return buildSessionContext(sm.getEntries(), sm.getLeafId()).messages as AnyMessage[];
	}

	function contextIndex(ctx: ExtensionContext): LeafIndex {
		return indexLeaves(contextMessages(ctx));
	}

	function buildModels(idx: LeafIndex): Record<ViewMode, ContextTreeModel> {
		return { general: buildTree(idx, state), session: buildSessionTree(idx, state) };
	}

	/** Compact footer readout: "ctx 6.0K/16.5K (36%)" when masking, "ctx 16.5K" otherwise. */
	function statusText(theme: Theme, model: ContextTreeModel): string {
		const raw = model.rawTotal;
		const effective = model.effectiveTotal;
		if (effective < raw) {
			const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
			return theme.fg("warning", `ctx ${formatCompact(effective)}/${formatCompact(raw)} (${pct}%)`);
		}
		return theme.fg("dim", `ctx ${formatCompact(raw)}`);
	}

	/** One-line widget below the editor while masks hide something or a cache break is pending. */
	function widgetLine(theme: Theme, model: ContextTreeModel, maskedItems: number, cache: CacheStatus): string {
		const raw = model.rawTotal;
		const effective = model.effectiveTotal;
		const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
		return (
			theme.fg("warning", " ◐ context-control ") +
			theme.fg("text", `${formatCompact(effective)} of ${formatCompact(raw)} sent (${pct}%)`) +
			(maskedItems > 0 ? theme.fg("muted", ` · ${maskedItems} item${maskedItems === 1 ? "" : "s"} masked`) : "") +
			(cache.pending
				? theme.fg("warning", ` · next call rewrites ~${formatCompact(cache.pending.rewrittenTokens)} cache`)
				: "") +
			theme.fg("muted", " · /ctx to manage")
		);
	}

	/** Real prompt size of the last call (input + cacheRead + cacheWrite). */
	function lastActualPrompt(messages: AnyMessage[]): number | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; usage?: { input: number; cacheRead: number; cacheWrite: number } };
			if (m.role === "assistant" && m.usage) {
				return m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
			}
		}
		return undefined;
	}

	/** Diff what we would send now against what the last call cached. */
	function cacheStatus(idx: LeafIndex): CacheStatus {
		const brk = diffAgainstSnapshot(sentStream(idx, state), lastSent);
		const status: CacheStatus = {
			hasSnapshot: (lastSent?.ids.length ?? 0) > 0,
			actualCached: lastSent?.actualPrompt,
		};
		if (brk.breakLeafId) {
			const leaf = idx.leaves.find((l) => l.id === brk.breakLeafId);
			const turnIndex = leaf ? idx.turns.findIndex((t) => t.id === leaf.turnId) : -1;
			status.pending = {
				breakLeafId: brk.breakLeafId,
				brokenTokens: brk.brokenTokens,
				rewrittenTokens: brk.rewrittenTokens,
				where: turnIndex >= 0 ? `turn ${turnIndex + 1}` : "earlier content",
			};
		}
		return status;
	}

	function refresh(ctx: ExtensionContext): void {
		const messages = contextMessages(ctx);
		const idx = indexLeaves(messages);
		const models = buildModels(idx);
		if (lastSent) lastSent.actualPrompt = lastActualPrompt(messages);
		const cache = cacheStatus(idx);
		panel?.setModels(models);
		panel?.setCacheStatus(cache);
		if (!ctx.hasUI) return;
		// Count what the masks actually hide, not raw mask ids: an armed group
		// rule with no matching content yet should not claim anything is masked.
		const maskedItems = maskedLeafCount(state, idx);
		ctx.ui.setStatus("context-control", statusText(ctx.ui.theme, models.general));
		ctx.ui.setWidget(
			"context-control",
			maskedItems > 0 || cache.pending
				? [widgetLine(ctx.ui.theme, models.general, maskedItems, cache)]
				: undefined,
			{ placement: "belowEditor" },
		);
	}

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, { masked: state.toJSON(), presetValues } satisfies PersistedState);
	}

	// The masking hook: filter/rewrite the outgoing messages on every LLM call.
	// Also the cache bookkeeping moment: what goes out on this call is exactly
	// what the provider will have cached when the next one is planned.
	pi.on("context", async (event) => {
		const messages = event.messages as AnyMessage[];
		lastSent = sentStream(indexLeaves(messages), state);
		if (state.size === 0) return;
		return { messages: applyMask(messages, state) as typeof event.messages };
	});

	// Restore persisted state; close any panel left over from a previous session.
	pi.on("session_start", async (_event, ctx) => {
		closePanel?.();
		let saved: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				saved = entry.data as PersistedState;
			}
		}
		state.load(saved?.masked);
		presetValues = saved?.presetValues ?? {};
		if (pruneStaleMasks(state, contextIndex(ctx)) > 0) persist();
		allPresets = [...PRESETS, ...loadUserPresets(ctx.cwd)];
		refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		closePanel?.();
	});

	// Keep an open panel current as the conversation grows.
	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));

	/** Give or take the panel's claim on the keyboard (the editor keeps real focus). */
	function setPanelFocus(focused: boolean): void {
		panelFocused = focused;
		if (panel) panel.focused = focused;
	}

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("context-control needs the interactive TUI", "warning");
			return;
		}
		// Already open (possibly unfocused while typing): take the keys back.
		if (panel) {
			setPanelFocus(true);
			panel.redraw();
			return;
		}

		// The panel lives in flow between the transcript and the editor, as an
		// above-editor widget. It stacks vertically with widgets from other
		// extensions (each key gets its own slot, insertion order top-down).
		ctx.ui.setWidget(
			PANEL_KEY,
			(tui, theme) => {
				panel = new ContextPanel(tui, theme, buildModels(contextIndex(ctx)), allPresets, presetValues, {
					onToggleMask: (node) => {
						toggleNodeMask(state, node, contextIndex(ctx).leaves);
						persist();
						refresh(ctx);
					},
					onImpact: (node) => toggleImpact(node, contextIndex(ctx), state, lastSent, cacheCosts(ctx.model)),
					onPreset: (preset, value) => {
						if (preset.apply(state, contextIndex(ctx), value) > 0) persist();
						refresh(ctx);
					},
					onPresetValues: (values) => {
						presetValues = values;
						persist();
					},
					onClose: () => closePanel?.(),
					onUnfocus: () => setPanelFocus(false),
				});
				panel.focused = true;
				return panel;
			},
			{ placement: "aboveEditor" },
		);
		panelFocused = true;
		// The widget factory ran synchronously above, so the panel exists now
		// (TS can't see through the closure assignment).
		(panel as ContextPanel | undefined)?.setCacheStatus(cacheStatus(contextIndex(ctx)));

		// The editor keeps real focus; this listener runs first in the TUI's
		// input chain and feeds the panel while it claims the keyboard.
		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!panel || !panelFocused) return undefined;
			// Never swallow pi's interrupt/quit chords.
			if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) return undefined;
			panel.handleInput(data);
			return { consume: true };
		});

		closePanel = () => {
			unsubscribe();
			panel = undefined;
			panelFocused = false;
			closePanel = undefined;
			ctx.ui.setWidget(PANEL_KEY, undefined);
		};
	}

	pi.registerCommand("ctx", {
		description: "Open the context control panel (mask messages/tools in and out of context)",
		handler: async (_args, ctx) => openPanel(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("c"), {
		description: "Toggle the context control panel",
		handler: openPanel,
	});
}
