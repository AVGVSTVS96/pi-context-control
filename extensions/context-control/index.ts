/**
 * pi-context-control — interactive context window manager for pi.
 *
 * /ctx opens a panel showing a tree of everything in the current LLM context
 * (grouped role → type → tool, down to individual messages) with token
 * estimates, and lets you mask any of it out of context at will.
 *
 * Masking is applied on the `context` event before every LLM call and never
 * modifies the session file — everything is reversible.
 */

import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type OverlayHandle } from "@earendil-works/pi-tui";
import type { AnyMessage } from "./keys.ts";
import { applyMask, MaskState, toggleNodeMask } from "./masking.ts";
import { ContextPanel } from "./panel.ts";
import { buildTree } from "./tree.ts";

const CUSTOM_TYPE = "context-control";

export default function contextControl(pi: ExtensionAPI): void {
	const state = new MaskState();
	let panel: ContextPanel | undefined;
	let handle: OverlayHandle | undefined;
	let closePanel: (() => void) | undefined;

	function contextMessages(ctx: ExtensionContext): AnyMessage[] {
		const sm = ctx.sessionManager;
		return buildSessionContext(sm.getEntries(), sm.getLeafId()).messages as AnyMessage[];
	}

	function refresh(ctx: ExtensionContext): void {
		panel?.setModel(buildTree(contextMessages(ctx), state));
	}

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, { masked: state.toJSON() });
	}

	// The masking hook: filter/rewrite the outgoing messages on every LLM call.
	pi.on("context", async (event) => {
		if (state.size === 0) return;
		return { messages: applyMask(event.messages as AnyMessage[], state) as typeof event.messages };
	});

	// Restore persisted mask state; close any panel left over from a previous session.
	pi.on("session_start", async (_event, ctx) => {
		closePanel?.();
		let saved: { masked?: string[] } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				saved = entry.data as { masked?: string[] };
			}
		}
		state.load(saved?.masked);
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
					panel = new ContextPanel(tui, theme, buildTree(contextMessages(ctx), state), {
						onToggleMask: (node) => {
							toggleNodeMask(state, node);
							persist();
							refresh(ctx);
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
