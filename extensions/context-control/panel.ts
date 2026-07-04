/**
 * The interactive context panel: a bordered tree of the current context with
 * occurrence counts and token columns, navigable with the keyboard.
 *
 * Two views over the same mask state, toggled with "v":
 *  - general: role → content-type → tool (what kinds of stuff)
 *  - session: turn → items in order   (when it happened)
 *
 * The panel renders inside a TUI overlay. It can hand keyboard focus back to
 * the editor while staying visible ("i"), and is refreshed from outside via
 * setModels() as the conversation grows.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { ToggleImpact } from "./cache.ts";
import { formatCompact, formatExact } from "./estimate.ts";
import type { Preset } from "./presets.ts";
import type { ContextTreeModel, TreeNode } from "./tree.ts";

export type TokenMode = "effective" | "raw";
export type ViewMode = "general" | "session";

/** What the panel knows about the prompt cache (computed outside, pushed in). */
export interface CacheStatus {
	/** A call has happened, so a cached prefix exists to protect. */
	hasSnapshot: boolean;
	/** Real cached prompt size from the provider's usage numbers, when known. */
	actualCached?: number;
	/** Mask changes since the last call will break the cache on the next one. */
	pending?: {
		/** First cached leaf whose sent form changed. */
		breakLeafId: string;
		brokenTokens: number;
		rewrittenTokens: number;
		/** Where the break lands, e.g. "turn 3". */
		where: string;
	};
}

export interface PanelCallbacks {
	/** Toggle mask state for a node; caller rebuilds the models and calls setModels(). */
	onToggleMask: (node: TreeNode) => void;
	/** Summarize the selected row range (session view); caller validates and generates. */
	onSummarize: (nodes: TreeNode[]) => void;
	/** Preview what toggling this node would do to per-call cost and the cache. */
	onImpact: (node: TreeNode) => ToggleImpact;
	/** Apply a mask preset with its current value; caller rebuilds and calls setModels(). */
	onPreset: (preset: Preset, value: number | undefined) => void;
	/** Persist tuned preset values. */
	onPresetValues: (values: Record<string, number>) => void;
	/** Close the panel entirely. */
	onClose: () => void;
	/** Keep the panel visible but return keyboard focus to the editor. */
	onUnfocus: () => void;
}

interface Row {
	node: TreeNode;
	/** Tree guide prefix ("│ ", "├ ", "└ ") aligned under the parent's marker. */
	guide: string;
}

const BODY_MAX_ROWS = 18;
const COUNT_COL = 7; // "1234x"
const TOKEN_COL = 10; // "1_234_567"

export class ContextPanel implements Focusable {
	focused = false;

	private models: Record<ViewMode, ContextTreeModel>;
	private view: ViewMode = "general";
	private mode: TokenMode = "effective";
	private expanded = new Set<string>();
	private selected: Record<ViewMode, number> = { general: 0, session: 0 };
	private scroll: Record<ViewMode, number> = { general: 0, session: 0 };
	private rows: Row[] = [];

	private presets: Preset[];
	private presetValues: Record<string, number>;
	private presetMode = false;
	private presetSelected = 0;

	/** First endpoint of an in-progress summarize range (session view). */
	private anchorId: string | undefined;
	/** One-shot footer message (cleared on the next key). */
	private notice: string | undefined;
	/** Summary row whose full digest is open in the detail view. */
	private detailNode: TreeNode | undefined;
	private detailScroll = 0;

	private cacheStatus: CacheStatus = { hasSnapshot: false };
	private impactMemo: { id: string; impact: ToggleImpact } | undefined;

	private tui: TUI;
	private theme: Theme;
	private callbacks: PanelCallbacks;

	constructor(
		tui: TUI,
		theme: Theme,
		models: Record<ViewMode, ContextTreeModel>,
		presets: Preset[],
		presetValues: Record<string, number>,
		callbacks: PanelCallbacks,
	) {
		this.tui = tui;
		this.theme = theme;
		this.callbacks = callbacks;
		this.models = models;
		this.presets = presets;
		this.presetValues = { ...presetValues };
		this.expandDefaults();
		this.rebuildRows();
	}

	private get model(): ContextTreeModel {
		return this.models[this.view];
	}

	setModels(models: Record<ViewMode, ContextTreeModel>): void {
		const selectedId = this.rows[this.selected[this.view]]?.node.id;
		this.models = models;
		this.impactMemo = undefined;
		this.rebuildRows();
		if (selectedId) {
			const idx = this.rows.findIndex((r) => r.node.id === selectedId);
			if (idx >= 0) this.selected[this.view] = idx;
		}
		this.selected[this.view] = Math.min(this.selected[this.view], Math.max(0, this.rows.length - 1));
		if (this.anchorId && this.rowIndexOf(this.anchorId) < 0) this.anchorId = undefined;
		// Keep an open detail view pointing at the fresh node (or close it if gone).
		if (this.detailNode) {
			const idx = this.rowIndexOf(this.detailNode.id);
			this.detailNode = idx >= 0 ? this.rows[idx].node : undefined;
			if (!this.detailNode?.summary) this.detailNode = undefined;
		}
		this.tui.requestRender();
	}

	private rowIndexOf(id: string): number {
		return this.rows.findIndex((r) => r.node.id === id);
	}

	/** Row index range of the in-progress summarize selection, inclusive. */
	private anchorRange(): [number, number] | undefined {
		if (!this.anchorId) return undefined;
		const a = this.rowIndexOf(this.anchorId);
		if (a < 0) return undefined;
		const b = this.selected[this.view];
		return a <= b ? [a, b] : [b, a];
	}

	setCacheStatus(status: CacheStatus): void {
		this.cacheStatus = status;
		this.impactMemo = undefined;
		this.tui.requestRender();
	}

	private impactFor(node: TreeNode): ToggleImpact {
		if (this.impactMemo?.id !== node.id) {
			this.impactMemo = { id: node.id, impact: this.callbacks.onImpact(node) };
		}
		return this.impactMemo.impact;
	}

	/** "mask: saves ~1.2K/call · rewrites ~8.0K cached · pays off in ~5 calls" */
	private impactText(node: TreeNode): string {
		if (node.kind === "summary") {
			// Applied → space restores the originals; switched off → space
			// re-applies the stored digest (no LLM call); generating → neither yet.
			const off = node.masked;
			if (!off && node.effectiveTokens === 0) return "summarizing…";
			const impact = this.impactFor(node);
			const delta = impact.deltaPerCall;
			const action = off ? "apply" : "restore";
			const verb = delta < 0 ? `adds ~${formatCompact(-delta)}/call back` : `saves ~${formatCompact(delta)}/call`;
			const rewritten = impact.extraRewrittenTokens;
			const view = " · <enter> view";
			if (!impact.hasCache) return `${action}: ${verb}${view}`;
			return rewritten > 0
				? `${action}: ${verb} · rewrites ~${formatCompact(rewritten)} cached${view}`
				: `${action}: ${verb} · breaks no cache${view}`;
		}
		const impact = this.impactFor(node);
		const delta = impact.deltaPerCall;
		const rewritten = impact.extraRewrittenTokens;
		if (delta === 0) {
			// A stub can cost as much as a tiny result: masking changes the bytes
			// (breaking the cache) without shrinking anything.
			return rewritten > 0 ? `mask: saves nothing · rewrites ~${formatCompact(rewritten)} cached — not worth it` : "";
		}
		if (delta < 0) {
			const base = `unmask: adds ~${formatCompact(-delta)}/call back`;
			if (!impact.hasCache) return base;
			return rewritten > 0 ? `${base} · rewrites ~${formatCompact(rewritten)} cached` : `${base} · breaks no cache`;
		}
		const base = `mask: saves ~${formatCompact(delta)}/call`;
		if (!impact.hasCache) return `${base} · nothing cached yet`;
		if (rewritten === 0) return `${base} · breaks no cache`;
		const calls = impact.paybackCalls ?? 0;
		return `${base} · rewrites ~${formatCompact(rewritten)} cached · pays off in ~${calls} call${calls === 1 ? "" : "s"}`;
	}

	/** Leaves the current masks hide — same number the below-editor widget shows. */
	private maskedItemCount(): number {
		let n = 0;
		const walk = (node: TreeNode) => {
			if (node.isLeaf) {
				if (node.masked) n++;
			} else {
				node.children.forEach(walk);
			}
		};
		this.model.roots.forEach(walk);
		return n;
	}

	/** Deepest visible row containing the pending break leaf (session view only). */
	private boundaryRowIndex(): number {
		const id = this.cacheStatus.pending?.breakLeafId;
		if (!id || this.view !== "session") return -1;
		const contains = (n: TreeNode): boolean => n.id === id || n.children.some(contains);
		let idx = -1;
		this.rows.forEach((row, i) => {
			if (contains(row.node)) idx = i;
		});
		return idx;
	}

	private presetValue(preset: Preset): number | undefined {
		if (!preset.param) return undefined;
		return this.presetValues[preset.id] ?? preset.defaultValue;
	}

	/**
	 * General view: expand groups whose children are groups, keep leaf lists
	 * collapsed. Session view: expand only the most recent turn.
	 */
	private expandDefaults(): void {
		const walk = (node: TreeNode) => {
			if (node.isLeaf) return;
			if (node.children.some((c) => !c.isLeaf)) this.expanded.add(node.id);
			for (const child of node.children) walk(child);
		};
		for (const root of this.models.general.roots) walk(root);
		const lastTurn = this.models.session.roots[this.models.session.roots.length - 1];
		if (lastTurn) this.expanded.add(lastTurn.id);
	}

	private rebuildRows(): void {
		this.rows = [];
		// Guide prefixes place each child's connector directly under its
		// parent's marker; `base` is the blank/│ run up to that column.
		const TEE = "├─ ";
		const ELBOW = "╰─ ";
		const PIPE = "│  ";
		const BLANK = "   ";
		const walkChildren = (node: TreeNode, base: string) => {
			node.children.forEach((child, i) => {
				const last = i === node.children.length - 1;
				this.rows.push({ node: child, guide: base + (last ? ELBOW : TEE) });
				if (!child.isLeaf && this.expanded.has(child.id)) {
					walkChildren(child, base + (last ? BLANK : PIPE));
				}
			});
		};
		for (const root of this.model.roots) {
			this.rows.push({ node: root, guide: "" });
			if (this.expanded.has(root.id)) {
				walkChildren(root, "");
			} else if (this.view === "session") {
				// Collapsed turn: keep the turn's final assistant message visible,
				// elbowed off the turn's marker, so every turn reads as user → reply.
				const reply = [...root.children].reverse().find((c) => c.kind === "assistant-text");
				if (reply) this.rows.push({ node: reply, guide: ELBOW });
			}
		}
	}

	handleInput(data: string): void {
		if (this.presetMode) {
			this.handlePresetInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.detailNode) {
			this.handleDetailInput(data);
			this.tui.requestRender();
			return;
		}
		this.handleTreeInput(data);
		this.tui.requestRender();
	}

	private handleTreeInput(data: string): void {
		const row = this.rows[this.selected[this.view]];
		this.notice = undefined;
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+alt+c")) {
			// esc backs out of an in-progress range before it closes the panel.
			if (this.anchorId && matchesKey(data, "escape")) {
				this.anchorId = undefined;
				return;
			}
			this.callbacks.onClose();
			return;
		}
		if (data === "i") {
			this.callbacks.onUnfocus();
			return;
		}
		if (data === "p") {
			this.presetMode = true;
			this.presetSelected = 0;
			return;
		}
		if (data === "v") {
			this.anchorId = undefined;
			this.view = this.view === "general" ? "session" : "general";
			this.rebuildRows();
			return;
		}
		if (data === "s") {
			if (this.view !== "session") {
				this.notice = "summaries live in the session view — <v> to switch";
				return;
			}
			if (!row) return;
			const range = this.anchorRange();
			if (!range) {
				if (row.node.kind === "summary") {
					this.notice = "already a summary — <space> applies/restores it";
					return;
				}
				this.anchorId = row.node.id;
				return;
			}
			this.anchorId = undefined;
			this.callbacks.onSummarize(this.rows.slice(range[0], range[1] + 1).map((r) => r.node));
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected[this.view] = Math.max(0, this.selected[this.view] - 1);
		} else if (matchesKey(data, "down")) {
			this.selected[this.view] = Math.min(this.rows.length - 1, this.selected[this.view] + 1);
		} else if (data === "g") {
			this.selected[this.view] = 0;
		} else if (data === "G") {
			this.selected[this.view] = this.rows.length - 1;
		} else if (matchesKey(data, "tab")) {
			this.mode = this.mode === "effective" ? "raw" : "effective";
		} else if (matchesKey(data, "right") || matchesKey(data, "return")) {
			if (row?.node.kind === "summary") {
				if (row.node.summary) {
					this.detailNode = row.node;
					this.detailScroll = 0;
				} else {
					this.notice = "still generating — <enter> shows the digest once it's done";
				}
				return;
			}
			if (row && !row.node.isLeaf) {
				if (this.expanded.has(row.node.id)) {
					if (matchesKey(data, "return")) this.expanded.delete(row.node.id);
				} else {
					this.expanded.add(row.node.id);
				}
				this.rebuildRows();
			}
		} else if (matchesKey(data, "left")) {
			if (row && !row.node.isLeaf && this.expanded.has(row.node.id)) {
				this.expanded.delete(row.node.id);
				this.rebuildRows();
			} else if (row?.node.parent) {
				const idx = this.rows.findIndex((r) => r.node.id === row.node.parent!.id);
				if (idx >= 0) this.selected[this.view] = idx;
			}
		} else if (matchesKey(data, "space") || data === "m") {
			if (row) this.callbacks.onToggleMask(row.node);
		}
		this.clampScroll();
	}

	private handlePresetInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "p") {
			this.presetMode = false;
			return;
		}
		if (matchesKey(data, "up")) {
			this.presetSelected = Math.max(0, this.presetSelected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.presetSelected = Math.min(this.presets.length - 1, this.presetSelected + 1);
			return;
		}
		const preset = this.presets[this.presetSelected];
		if (preset?.param && (matchesKey(data, "left") || matchesKey(data, "right"))) {
			const { min, max, step } = preset.param;
			const current = this.presetValue(preset) ?? min;
			const next = Math.max(min, Math.min(max, current + (matchesKey(data, "right") ? step : -step)));
			this.presetValues[preset.id] = next;
			this.callbacks.onPresetValues({ ...this.presetValues });
			return;
		}
		let pick = -1;
		if (matchesKey(data, "return") || matchesKey(data, "space")) {
			pick = this.presetSelected;
		} else if (/^[1-9]$/.test(data)) {
			pick = Number(data) - 1;
		}
		if (pick >= 0 && pick < this.presets.length) {
			const picked = this.presets[pick];
			this.presetMode = false;
			this.callbacks.onPreset(picked, this.presetValue(picked));
		}
	}

	/** Digest detail view: read-only, ↑↓ scroll, anything else backs out. */
	private handleDetailInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.detailScroll = Math.max(0, this.detailScroll - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.detailScroll += 1; // clamped against the wrapped text in render()
			return;
		}
		if (matchesKey(data, "ctrl+alt+c")) {
			this.callbacks.onClose();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "left") || data === "q") {
			this.detailNode = undefined;
		}
	}

	/** Greedy word wrap, newlines preserved (digests are prose or bullets). */
	private wrapText(text: string, width: number): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			if (visibleWidth(raw) <= width) {
				out.push(raw);
				continue;
			}
			let line = "";
			for (const word of raw.split(" ")) {
				if (line && visibleWidth(`${line} ${word}`) > width) {
					out.push(line);
					line = word;
				} else {
					line = line ? `${line} ${word}` : word;
				}
				while (visibleWidth(line) > width) {
					out.push(line.slice(0, width));
					line = line.slice(width);
				}
			}
			out.push(line);
		}
		return out;
	}

	private clampScroll(): void {
		const visible = Math.min(BODY_MAX_ROWS, this.rows.length);
		const sel = this.selected[this.view];
		let scroll = this.scroll[this.view];
		if (sel < scroll) scroll = sel;
		if (sel >= scroll + visible) scroll = sel - visible + 1;
		this.scroll[this.view] = Math.max(0, Math.min(scroll, Math.max(0, this.rows.length - visible)));
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(56, width);
		const innerW = w - 2;
		const lines: string[] = [];

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const boxRow = (content: string) => th.fg("border", "│") + pad(` ${content}`, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// Header
		const title = this.presetMode
			? "Context Token Usage — presets"
			: this.detailNode
				? "Context Token Usage — summary digest"
				: `Context Token Usage (${this.mode} · ${this.view} view)`;
		lines.push(boxRow(th.bold(th.fg("accent", title))));
		const raw = this.model.rawTotal;
		const effective = this.model.effectiveTotal;
		const maskedOut = Math.max(0, raw - effective);
		const maskedItems = this.maskedItemCount();
		const items = maskedItems > 0 ? ` (${maskedItems} item${maskedItems === 1 ? "" : "s"})` : "";
		const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
		lines.push(
			boxRow(
				th.fg("muted", "messages: ") +
					th.fg("text", String(this.model.messageCount)) +
					th.fg("muted", " · tokens: ") +
					th.fg("text", `${formatCompact(raw)} raw`) +
					th.fg("muted", " · ") +
					th.fg("warning", `${formatCompact(maskedOut)} masked out${items}`) +
					th.fg("muted", " · ") +
					th.fg("success", `${formatCompact(effective)} effective (${pct}%)`) +
					th.fg("muted", " · estimated"),
			),
		);
		lines.push(
			boxRow(
				th.fg(
					"dim",
					!this.focused
						? "typing in editor — /ctx or ctrl+alt+c to control the panel"
						: this.presetMode
							? "↑↓ move · ←→ adjust ‹value› · <enter> apply · <1-9> quick apply · <esc> back"
							: this.detailNode
								? "↑↓ scroll · <esc> back"
								: this.anchorId
								? "↑↓ extend range · <s> summarize selection · <esc> cancel"
								: this.view === "session"
									? "↑↓ move · <space> mask · <s> summarize · <tab> raw/eff · <v> view · <p> presets · <esc> close"
									: "↑↓ move · ←→ fold · <space> mask · <tab> raw/eff · <v> view · <p> presets · <i> input · <esc> close",
				),
			),
		);
		// Pending cache break: masks changed since the last call take effect (and
		// break the cache once, at the earliest change) on the next call.
		const pending = this.cacheStatus.pending;
		if (pending && !this.presetMode && !this.detailNode) {
			const cached = this.cacheStatus.actualCached;
			const note =
				`⚡ pending: cache breaks at ${pending.where} · ` +
				`~${formatCompact(pending.rewrittenTokens)} rewritten next call` +
				(cached ? ` (${formatCompact(cached)} cached now)` : "");
			lines.push(boxRow(th.fg("warning", note.slice(0, innerW - 2))));
		}
		lines.push(boxRow(th.fg("borderMuted", "─".repeat(innerW - 2))));

		// Body
		if (this.presetMode) {
			for (let i = 0; i < this.presets.length; i++) {
				lines.push(this.renderPresetRow(i, i === this.presetSelected, innerW));
			}
			lines.push(boxRow(th.fg("dim", `(${this.presetSelected + 1}/${this.presets.length})`)));
			lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
			return lines;
		}
		if (this.detailNode?.summary) {
			const node = this.detailNode;
			const summary = this.detailNode.summary;
			const status = node.masked ? "switched off" : node.effectiveTokens > 0 ? "applied" : "";
			lines.push(
				boxRow(
					th.fg("muted", "generated by ") +
						th.fg("text", summary.model) +
						(status ? th.fg("muted", " · ") + th.fg(node.masked ? "warning" : "success", status) : ""),
				),
			);
			const wrapped = this.wrapText(summary.text, innerW - 4);
			const visibleText = Math.min(BODY_MAX_ROWS, wrapped.length);
			this.detailScroll = Math.max(0, Math.min(this.detailScroll, wrapped.length - visibleText));
			for (let i = this.detailScroll; i < this.detailScroll + visibleText; i++) {
				lines.push(boxRow(` ${th.fg("text", wrapped[i])}`));
			}
			const at = wrapped.length > visibleText ? ` (${this.detailScroll + visibleText}/${wrapped.length} lines)` : "";
			lines.push(boxRow(th.fg("dim", `§ ${node.label}${at}`.slice(0, innerW - 2))));
			lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
			return lines;
		}
		this.clampScroll();
		const visible = Math.min(BODY_MAX_ROWS, this.rows.length);
		const scroll = this.scroll[this.view];
		const boundary = this.boundaryRowIndex();
		const range = this.focused ? this.anchorRange() : undefined;
		for (let i = scroll; i < scroll + visible; i++) {
			const row = this.rows[i];
			if (!row) break;
			// Session view is chronological = cache order, so the break point is a
			// real line in the list: everything below it is rewritten next call.
			if (i === boundary) {
				const label = "┄┄ cache breaks here · everything below is rewritten next call ";
				lines.push(boxRow(th.fg("warning", label.slice(0, innerW - 2).padEnd(innerW - 2, "┄"))));
			}
			const inRange = range !== undefined && i >= range[0] && i <= range[1];
			lines.push(this.renderRow(row, i === this.selected[this.view] || inRange, innerW));
		}

		// Footer: position + a notice, the pending range, or the selected node's impact.
		const selectedRow = this.rows[this.selected[this.view]];
		const pos = th.fg("dim", `(${this.rows.length === 0 ? 0 : this.selected[this.view] + 1}/${this.rows.length})`);
		let info = "";
		if (this.notice) info = this.notice;
		else if (range) {
			const stats = this.rangeStats(range);
			info = `summarize: ~${formatCompact(stats.tokens)} across ${stats.items} item${stats.items === 1 ? "" : "s"} — <s> to confirm`;
		} else if (selectedRow && this.focused) {
			info = this.impactText(selectedRow.node);
		}
		lines.push(boxRow(info ? `${pos}${th.fg("muted", " · ")}${th.fg("text", info.slice(0, innerW - 12))}` : pos));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	/** Unique leaves under the range rows (summary rows excluded — they can't be re-summarized). */
	private rangeStats(range: [number, number]): { items: number; tokens: number } {
		const seen = new Set<string>();
		let tokens = 0;
		const visit = (n: TreeNode) => {
			if (n.kind === "summary") return;
			if (n.isLeaf) {
				if (!seen.has(n.id)) {
					seen.add(n.id);
					tokens += n.rawTokens;
				}
				return;
			}
			n.children.forEach(visit);
		};
		for (let i = range[0]; i <= range[1]; i++) {
			const row = this.rows[i];
			if (row) visit(row.node);
		}
		return { items: seen.size, tokens };
	}

	private renderPresetRow(index: number, isSelected: boolean, innerW: number): string {
		const th = this.theme;
		const preset = this.presets[index];
		const num = th.fg("warning", `${index + 1}.`);
		const label = th.fg("text", preset.label(this.presetValue(preset)));
		const tunable = preset.param ? th.fg("dim", "  ←→") : "";
		let line = `  ${num} ${label}${tunable}`;
		line += " ".repeat(Math.max(0, innerW - visibleWidth(line)));
		if (isSelected) line = th.bg("selectedBg", line);
		return th.fg("border", "│") + line + th.fg("border", "│");
	}

	private renderRow(row: Row, isSelected: boolean, innerW: number): string {
		const th = this.theme;
		const { node, guide } = row;
		const partial = !node.masked && node.effectiveTokens < node.rawTokens;

		// Markers show MASK state only: ✕ masked · ◐ partially masked · ○ in
		// context · § a summary standing in for replaced content. Folded nodes
		// show their label in bold instead.
		const isSummary = node.kind === "summary";
		const generating = isSummary && !node.masked && node.effectiveTokens === 0;
		const marker = isSummary ? "§" : node.masked ? "✕" : partial ? "◐" : "○";
		const folded = !node.isLeaf && !this.expanded.has(node.id);

		const labelW = Math.max(10, innerW - COUNT_COL - TOKEN_COL - 12);
		const headW = visibleWidth(`${guide}${marker} `);
		let label = node.label || "(empty)";
		if (headW + visibleWidth(label) > labelW) {
			label = `${label.slice(0, Math.max(1, labelW - headW - 2))}…`;
		}

		const count = `${node.count}x`.padStart(COUNT_COL);
		const tokens = formatExact(this.mode === "effective" ? node.effectiveTokens : node.rawTokens).padStart(TOKEN_COL);

		// Colors
		let markerColored: string;
		let labelColored: string;
		if (isSummary) {
			markerColored = th.fg(generating || node.masked ? "dim" : "success", marker);
			// Switched off: masked styling, so it reads as "here, but not sent".
			labelColored = node.masked ? th.fg("dim", th.strikethrough(label)) : th.fg(generating ? "dim" : "text", label);
		} else if (node.masked) {
			markerColored = th.fg("error", marker);
			labelColored = th.fg("dim", th.strikethrough(label));
		} else if (partial) {
			markerColored = th.fg("warning", marker);
			labelColored = th.fg("text", label);
		} else {
			markerColored = th.fg("accent", marker);
			labelColored = node.isLeaf ? th.fg("muted", label) : th.fg("text", label);
		}
		if (folded) labelColored = th.bold(labelColored);

		const left = `${th.fg("dim", guide)}${markerColored} ${labelColored}`;
		const pad = " ".repeat(Math.max(1, labelW - headW - visibleWidth(label)));
		const countColored = th.fg("warning", count);
		const tokensColored = node.masked ? th.fg("dim", tokens) : th.fg("accent", tokens);
		const unit = th.fg("muted", " tokens");

		let line = ` ${left}${pad}${countColored}  ${tokensColored}${unit}`;
		const lineW = visibleWidth(line);
		line += " ".repeat(Math.max(0, innerW - lineW));

		if (isSelected && this.focused) {
			line = th.bg("selectedBg", line);
		}
		return th.fg("border", "│") + line + th.fg("border", "│");
	}

	/** Ask the TUI for a repaint (used when focus state changes from outside). */
	redraw(): void {
		this.tui.requestRender();
	}

	invalidate(): void {}
	dispose(): void {}
}
