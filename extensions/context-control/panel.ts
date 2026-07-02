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
import { formatCompact, formatExact } from "./estimate.ts";
import type { Preset } from "./presets.ts";
import type { ContextTreeModel, TreeNode } from "./tree.ts";

export type TokenMode = "effective" | "raw";
export type ViewMode = "general" | "session";

export interface PanelCallbacks {
	/** Toggle mask state for a node; caller rebuilds the models and calls setModels(). */
	onToggleMask: (node: TreeNode) => void;
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
		this.rebuildRows();
		if (selectedId) {
			const idx = this.rows.findIndex((r) => r.node.id === selectedId);
			if (idx >= 0) this.selected[this.view] = idx;
		}
		this.selected[this.view] = Math.min(this.selected[this.view], Math.max(0, this.rows.length - 1));
		this.tui.requestRender();
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
			return;
		}
		const row = this.rows[this.selected[this.view]];
		if (matchesKey(data, "escape") || data === "q") {
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
			this.view = this.view === "general" ? "session" : "general";
			this.rebuildRows();
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
			: `Context Token Usage (${this.mode} · ${this.view} view)`;
		lines.push(boxRow(th.bold(th.fg("accent", title))));
		const raw = this.model.rawTotal;
		const effective = this.model.effectiveTotal;
		const maskedOut = Math.max(0, raw - effective);
		const pct = raw > 0 ? Math.round((effective / raw) * 100) : 100;
		lines.push(
			boxRow(
				th.fg("muted", "messages: ") +
					th.fg("text", String(this.model.messageCount)) +
					th.fg("muted", " · tokens: ") +
					th.fg("text", `${formatCompact(raw)} raw`) +
					th.fg("muted", " · ") +
					th.fg("warning", `${formatCompact(maskedOut)} masked out`) +
					th.fg("muted", " · ") +
					th.fg("success", `${formatCompact(effective)} effective (${pct}%)`) +
					th.fg("muted", " · estimated"),
			),
		);
		lines.push(
			boxRow(
				th.fg(
					"dim",
					this.presetMode
						? "↑↓ move · ←→ adjust ‹value› · <enter> apply · <1-9> quick apply · <esc> back"
						: "↑↓ move · ←→ fold · <space> mask · <tab> raw/eff · <v> view · <p> presets · <i> input · <esc> close",
				),
			),
		);
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
		this.clampScroll();
		const visible = Math.min(BODY_MAX_ROWS, this.rows.length);
		const scroll = this.scroll[this.view];
		for (let i = scroll; i < scroll + visible; i++) {
			const row = this.rows[i];
			if (!row) break;
			lines.push(this.renderRow(row, i === this.selected[this.view], innerW));
		}

		// Footer position indicator
		lines.push(
			boxRow(th.fg("dim", `(${this.rows.length === 0 ? 0 : this.selected[this.view] + 1}/${this.rows.length})`)),
		);
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
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

		// ✕ masked · ◐ partially masked · ● collapsed (content folded inside) · ○ fully shown
		const collapsed = !node.isLeaf && !this.expanded.has(node.id);
		const marker = node.masked ? "✕" : partial ? "◐" : collapsed ? "●" : "○";

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
		if (node.masked) {
			markerColored = th.fg("error", marker);
			labelColored = th.fg("dim", th.strikethrough(label));
		} else if (partial) {
			markerColored = th.fg("warning", marker);
			labelColored = th.fg("text", label);
		} else {
			markerColored = th.fg("accent", marker);
			labelColored = node.isLeaf ? th.fg("muted", label) : th.fg("text", label);
		}

		const left = `${th.fg("dim", guide)}${markerColored} ${labelColored}`;
		const pad = " ".repeat(Math.max(1, labelW - headW - visibleWidth(label)));
		const countColored = th.fg("warning", count);
		const tokensColored = node.masked ? th.fg("dim", tokens) : th.fg("accent", tokens);
		const unit = th.fg("muted", " tokens");

		let line = ` ${left}${pad}${countColored}  ${tokensColored}${unit}`;
		const lineW = visibleWidth(line);
		line += " ".repeat(Math.max(0, innerW - lineW));

		if (isSelected) {
			line = th.bg("selectedBg", line);
		}
		return th.fg("border", "│") + line + th.fg("border", "│");
	}

	invalidate(): void {}
	dispose(): void {}
}
