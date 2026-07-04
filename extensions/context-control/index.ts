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
import {
	cacheCosts,
	diffAgainstSnapshot,
	type SentSnapshot,
	sentStream,
	summaryToggleImpact,
	toggleImpact,
} from "./cache.ts";
import { formatCompact } from "./estimate.ts";
import type { AnyMessage } from "./keys.ts";
import { indexLeaves, type LeafIndex, maskedLeafCount, pruneStaleMasks } from "./leaves.ts";
import { applyMask, MaskState, toggleNodeMask } from "./masking.ts";
import { type CacheStatus, ContextPanel, type ViewMode } from "./panel.ts";
import { type Preset, PRESETS, toPreset, type UserPresetConfig } from "./presets.ts";
import {
	applySummaries,
	canonicalSpan,
	generateSpanSummary,
	parseModelSpec,
	spanLeafIds,
	type SummaryRecord,
	SummaryStore,
	spanMessages,
} from "./summaries.ts";
import { buildSessionTree, buildTree, type ContextTreeModel, type TreeNode } from "./tree.ts";

const CUSTOM_TYPE = "context-control";
const PANEL_KEY = "context-control:panel";
const SUMMARIZE_MODEL_ENV = "PI_CONTEXT_CONTROL_SUMMARIZE_MODEL";

interface PersistedState {
	masked?: string[];
	presetValues?: Record<string, number>;
	summaries?: SummaryRecord[];
}

interface UserConfig {
	presets: Preset[];
	/** "provider/model-id" to summarize with (project file wins over global). */
	summarizeModel?: string;
}

/** User config from .pi/context-control.json (project) and ~/.pi/context-control.json. */
function loadUserConfig(cwd: string): UserConfig {
	const config: UserConfig = { presets: [] };
	for (const file of [join(homedir(), ".pi", "context-control.json"), join(cwd, ".pi", "context-control.json")]) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as {
				presets?: UserPresetConfig[];
				summarizeModel?: string;
			};
			for (const cfg of parsed.presets ?? []) {
				if (typeof cfg?.label === "string") config.presets.push(toPreset(cfg, config.presets.length));
			}
			if (typeof parsed.summarizeModel === "string") config.summarizeModel = parsed.summarizeModel;
		} catch {
			// Malformed config: skip silently rather than break the session.
		}
	}
	return config;
}

export default function contextControl(pi: ExtensionAPI): void {
	const state = new MaskState();
	const store = new SummaryStore();
	/** In-flight summary generations by record id, so they can be cancelled. */
	const generations = new Map<string, AbortController>();
	let summarizeModelSpec: string | undefined;
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
		const records = store.visible(idx);
		return { general: buildTree(idx, state, records), session: buildSessionTree(idx, state, records) };
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

	/** One-line widget below the editor while masks/summaries change what is sent. */
	function widgetLine(
		theme: Theme,
		model: ContextTreeModel,
		maskedItems: number,
		summarized: number,
		cache: CacheStatus,
	): string {
		const raw = model.rawTotal;
		const effective = model.effectiveTotal;
		const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
		return (
			theme.fg("warning", " ◐ context-control ") +
			theme.fg("text", `${formatCompact(effective)} of ${formatCompact(raw)} sent (${pct}%)`) +
			(maskedItems > 0 ? theme.fg("muted", ` · ${maskedItems} item${maskedItems === 1 ? "" : "s"} masked`) : "") +
			(summarized > 0 ? theme.fg("muted", ` · ${summarized} span${summarized === 1 ? "" : "s"} summarized`) : "") +
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
		const brk = diffAgainstSnapshot(sentStream(idx, state, store.applicable(idx)), lastSent);
		const status: CacheStatus = {
			hasSnapshot: (lastSent?.ids.length ?? 0) > 0,
			actualCached: lastSent?.actualPrompt,
		};
		if (brk.breakLeafId) {
			// A digest in the cached stream locates at its span's first leaf.
			const leafId = brk.breakLeafId.startsWith("sum:")
				? (store.get(brk.breakLeafId.slice(4))?.leafIds[0] ?? brk.breakLeafId)
				: brk.breakLeafId;
			const leaf = idx.leaves.find((l) => l.id === leafId);
			const turnIndex = leaf ? idx.turns.findIndex((t) => t.id === leaf.turnId) : -1;
			status.pending = {
				breakLeafId: leafId,
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
		const summarized = store.applicable(idx).length;
		ctx.ui.setStatus("context-control", statusText(ctx.ui.theme, models.general));
		ctx.ui.setWidget(
			"context-control",
			maskedItems > 0 || summarized > 0 || cache.pending
				? [widgetLine(ctx.ui.theme, models.general, maskedItems, summarized, cache)]
				: undefined,
			{ placement: "belowEditor" },
		);
	}

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, {
			masked: state.toJSON(),
			presetValues,
			summaries: store.toJSON(),
		} satisfies PersistedState);
	}

	// The transform hook: filter/rewrite the outgoing messages on every LLM
	// call — masks first, then summarized spans swap for their digests. Also
	// the cache bookkeeping moment: what goes out on this call is exactly
	// what the provider will have cached when the next one is planned.
	pi.on("context", async (event) => {
		const messages = event.messages as AnyMessage[];
		const idx = indexLeaves(messages);
		const active = store.applicable(idx);
		lastSent = sentStream(idx, state, active);
		if (state.size === 0 && active.length === 0) return;
		let out = messages;
		if (state.size > 0) out = applyMask(out, state);
		if (active.length > 0) out = applySummaries(out, active);
		return { messages: out as typeof event.messages };
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
		store.load(saved?.summaries);
		presetValues = saved?.presetValues ?? {};
		const idx = contextIndex(ctx);
		if (pruneStaleMasks(state, idx) + store.prune(idx) > 0) persist();
		const config = loadUserConfig(ctx.cwd);
		allPresets = [...PRESETS, ...config.presets];
		summarizeModelSpec = config.summarizeModel;
		refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const controller of generations.values()) controller.abort();
		generations.clear();
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

	/** Env var beats config beats the session's own model. */
	function resolveSummarizer(ctx: ExtensionContext): ExtensionContext["model"] {
		const spec = process.env[SUMMARIZE_MODEL_ENV] || summarizeModelSpec;
		if (spec) {
			const parsed = parseModelSpec(spec);
			const found = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
			if (found) return found;
			ctx.ui.notify(`summarize model "${spec}" not found — using the session model`, "warning");
		}
		return ctx.model;
	}

	/** Space on a summary row: cancel if generating, otherwise apply/restore the swap. */
	function toggleSummary(ctx: ExtensionContext, recordId: string): void {
		const record = store.get(recordId);
		if (!record) return;
		if (record.pending) {
			generations.get(record.id)?.abort();
			generations.delete(record.id);
			store.remove(record.id);
		} else {
			if (record.active) record.active = false;
			else store.activate(record); // switches off any overlapping record
			persist();
		}
		refresh(ctx);
	}

	/** Applied summaries anywhere under a tree node. */
	function appliedSummariesUnder(node: TreeNode): SummaryRecord[] {
		const out: SummaryRecord[] = [];
		const visit = (n: TreeNode) => {
			if (n.id.startsWith("sum:")) {
				const record = store.get(n.id.slice(4));
				if (record?.active && !record.pending) out.push(record);
				return;
			}
			for (const child of n.children) visit(child);
		};
		visit(node);
		return out;
	}

	/** Any real (non-summary) content under the node hidden by masks. */
	function hasMaskedContent(node: TreeNode): boolean {
		if (node.kind === "summary") return false;
		if (node.isLeaf) return node.masked;
		return state.has(node.id) || node.children.some(hasMaskedContent);
	}

	/**
	 * Space on a non-summary node. Same two-state cycle as plain masking, but
	 * an applied summary under the node counts as hidden content: the first
	 * press brings everything back (restore summaries + clear masks), the
	 * next press masks the whole node. Summaries are only switched off, never
	 * discarded.
	 */
	function toggleNode(ctx: ExtensionContext, node: TreeNode): void {
		const applied = appliedSummariesUnder(node);
		if (applied.length > 0) {
			for (const record of applied) record.active = false;
			if (hasMaskedContent(node)) toggleNodeMask(state, node, contextIndex(ctx).leaves);
		} else {
			toggleNodeMask(state, node, contextIndex(ctx).leaves);
		}
		persist();
		refresh(ctx);
	}

	async function summarizeSpan(ctx: ExtensionContext, nodes: TreeNode[]): Promise<void> {
		const span = canonicalSpan(spanLeafIds(nodes), contextIndex(ctx));
		if (span.length === 0) {
			ctx.ui.notify("nothing to summarize in that range", "warning");
			return;
		}

		// The same span again: re-apply the cached digest, no LLM call needed.
		const existing = store.findBySpan(span);
		if (existing) {
			if (!existing.pending && !existing.active) {
				store.activate(existing);
				persist();
				refresh(ctx);
			}
			return;
		}

		const model = resolveSummarizer(ctx);
		if (!model) {
			ctx.ui.notify("no model available to summarize with", "error");
			return;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`can't authenticate ${model.provider}: ${auth.error}`, "error");
			return;
		}

		const record: SummaryRecord = {
			id: Math.random().toString(36).slice(2, 10),
			leafIds: span,
			text: "",
			model: `${model.provider}/${model.id}`,
			active: false,
			pending: true,
			createdAt: Date.now(),
		};
		store.add(record);
		refresh(ctx); // shows the "generating…" row immediately

		const controller = new AbortController();
		generations.set(record.id, controller);
		try {
			const excerpt = spanMessages(contextMessages(ctx), new Set(span));
			const text = await generateSpanSummary(
				excerpt,
				model,
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
				controller.signal,
			);
			if (!store.get(record.id)) return; // cancelled while generating
			store.removeOverlapping(span, record.id); // a re-summarize replaces old spans
			record.text = text;
			record.pending = false;
			record.active = true;
			persist();
			refresh(ctx);
		} catch (err) {
			if (store.get(record.id)) {
				store.remove(record.id);
				refresh(ctx);
				ctx.ui.notify(`summarization failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		} finally {
			generations.delete(record.id);
		}
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
						if (node.id.startsWith("sum:")) toggleSummary(ctx, node.id.slice(4));
						else toggleNode(ctx, node);
					},
					onSummarize: (nodes) => void summarizeSpan(ctx, nodes),
					onImpact: (node) => {
						const idx = contextIndex(ctx);
						const active = store.applicable(idx);
						const costs = cacheCosts(ctx.model);
						if (node.id.startsWith("sum:")) {
							const record = store.get(node.id.slice(4));
							if (record && !record.pending) {
								return summaryToggleImpact(record, idx, state, active, lastSent, costs);
							}
							return {
								deltaPerCall: 0,
								extraBrokenTokens: 0,
								extraRewrittenTokens: 0,
								hasCache: (lastSent?.ids.length ?? 0) > 0,
							};
						}
						return toggleImpact(node, idx, state, lastSent, costs, active);
					},
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
