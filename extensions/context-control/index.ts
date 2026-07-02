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
import { Key, type OverlayHandle } from "@earendil-works/pi-tui";
import { formatCompact } from "./estimate.ts";
import type { AnyMessage } from "./keys.ts";
import { indexLeaves, type LeafIndex } from "./leaves.ts";
import { applyMask, MaskState, toggleNodeMask } from "./masking.ts";
import { ContextPanel, type ViewMode } from "./panel.ts";
import { type Preset, PRESETS, toPreset, type UserPresetConfig } from "./presets.ts";
import { buildSessionTree, buildTree, type ContextTreeModel } from "./tree.ts";

const CUSTOM_TYPE = "context-control";

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
	let handle: OverlayHandle | undefined;
	let closePanel: (() => void) | undefined;

	function contextIndex(ctx: ExtensionContext): LeafIndex {
		const sm = ctx.sessionManager;
		return indexLeaves(buildSessionContext(sm.getEntries(), sm.getLeafId()).messages as AnyMessage[]);
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

	/** One-line widget below the editor, shown only while masks are active. */
	function widgetLine(theme: Theme, model: ContextTreeModel): string {
		const raw = model.rawTotal;
		const effective = model.effectiveTotal;
		const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
		return (
			theme.fg("warning", " ◐ context-control ") +
			theme.fg("text", `${formatCompact(effective)} of ${formatCompact(raw)} sent (${pct}%)`) +
			theme.fg("muted", ` · ${state.size} mask${state.size === 1 ? "" : "s"} · /ctx to manage`)
		);
	}

	function refresh(ctx: ExtensionContext): void {
		const models = buildModels(contextIndex(ctx));
		panel?.setModels(models);
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("context-control", statusText(ctx.ui.theme, models.general));
		ctx.ui.setWidget("context-control", state.size > 0 ? [widgetLine(ctx.ui.theme, models.general)] : undefined, {
			placement: "belowEditor",
		});
	}

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, { masked: state.toJSON(), presetValues } satisfies PersistedState);
	}

	// The masking hook: filter/rewrite the outgoing messages on every LLM call.
	pi.on("context", async (event) => {
		if (state.size === 0) return;
		return { messages: applyMask(event.messages as AnyMessage[], state) as typeof event.messages };
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
		allPresets = [...PRESETS, ...loadUserPresets(ctx.cwd)];
		refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		closePanel?.();
	});

	// Keep an open panel current as the conversation grows.
	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => refresh(ctx));

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("context-control needs the interactive TUI", "warning");
			return;
		}
		// Already open (possibly unfocused while typing): bring it back.
		if (panel && handle) {
			handle.setHidden(false);
			handle.focus();
			return;
		}

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					closePanel = () => done(undefined);
					panel = new ContextPanel(tui, theme, buildModels(contextIndex(ctx)), allPresets, presetValues, {
						onToggleMask: (node) => {
							toggleNodeMask(state, node, contextIndex(ctx).leaves);
							persist();
							refresh(ctx);
						},
						onPreset: (preset, value) => {
							if (preset.apply(state, contextIndex(ctx), value) > 0) persist();
							refresh(ctx);
						},
						onPresetValues: (values) => {
							presetValues = values;
							persist();
						},
						onClose: () => done(undefined),
						onUnfocus: () => handle?.unfocus(),
					});
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "80%",
						anchor: "bottom-center",
						margin: { bottom: 6, left: 1, right: 1 },
					},
					onHandle: (h) => {
						handle = h;
					},
				},
			)
			.then(() => {
				panel = undefined;
				handle = undefined;
				closePanel = undefined;
			});
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
