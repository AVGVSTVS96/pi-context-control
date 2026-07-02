/**
 * The interactive context panel: a bordered tree of the current context with
 * occurrence counts and token columns, navigable with the keyboard.
 *
 * The panel renders inside a TUI overlay. It can hand keyboard focus back to
 * the editor while staying visible ("i"), and is refreshed from outside via
 * setModel() as the conversation grows.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompact, formatExact } from "./estimate.ts";
import { PRESETS, type Preset } from "./presets.ts";
import type { ContextTreeModel, TreeNode } from "./tree.ts";

export type TokenMode = "effective" | "raw";

export interface PanelCallbacks {
	/** Toggle mask state for a node; caller rebuilds the model and calls setModel(). */
	onToggleMask: (node: TreeNode) => void;
	/** Apply a mask preset; caller rebuilds the model and calls setModel(). */
	onPreset: (preset: Preset) => void;
	/** Close the panel entirely. */
	onClose: () => void;
	/** Keep the panel visible but return keyboard focus to the editor. */
	onUnfocus: () => void;
}

interface Row {
	node: TreeNode;
	depth: number;
}

const BODY_MAX_ROWS = 18;
const COUNT_COL = 7; // "1234x"
const TOKEN_COL = 10; // "1_234_567"

export class ContextPanel implements Focusable {
	focused = false;

	private model: ContextTreeModel;
	private mode: TokenMode = "effective";
	private expanded = new Set<string>();
	private selected = 0;
	private scroll = 0;
	private rows: Row[] = [];
	private presetMode = false;
	private presetSelected = 0;

	private tui: TUI;
	private theme: Theme;
	private callbacks: PanelCallbacks;

	constructor(tui: TUI, theme: Theme, model: ContextTreeModel, callbacks: PanelCallbacks) {
		this.tui = tui;
		this.theme = theme;
		this.callbacks = callbacks;
		this.model = model;
		this.expandDefaults();
		this.rebuildRows();
	}

	setModel(model: ContextTreeModel): void {
		const selectedId = this.rows[this.selected]?.node.id;
		this.model = model;
		this.rebuildRows();
		if (selectedId) {
			const idx = this.rows.findIndex((r) => r.node.id === selectedId);
			if (idx >= 0) this.selected = idx;
		}
		this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
		this.tui.requestRender();
	}

	/** Expand groups whose children are groups; keep leaf lists collapsed. */
	private expandDefaults(): void {
		const walk = (node: TreeNode) => {
			if (node.isLeaf) return;
			if (node.children.some((c) => !c.isLeaf)) this.expanded.add(node.id);
			for (const child of node.children) walk(child);
		};
		for (const root of this.model.roots) walk(root);
	}

	private rebuildRows(): void {
		this.rows = [];
		const walk = (node: TreeNode, depth: number) => {
			this.rows.push({ node, depth });
			if (!node.isLeaf && this.expanded.has(node.id)) {
				for (const child of node.children) walk(child, depth + 1);
			}
		};
		for (const root of this.model.roots) walk(root, 0);
	}

	handleInput(data: string): void {
		if (this.presetMode) {
			this.handlePresetInput(data);
			return;
		}
		const row = this.rows[this.selected];
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
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
		} else if (data === "g") {
			this.selected = 0;
		} else if (data === "G") {
			this.selected = this.rows.length - 1;
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
				if (idx >= 0) this.selected = idx;
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
			this.presetSelected = Math.min(PRESETS.length - 1, this.presetSelected + 1);
			return;
		}
		let pick = -1;
		if (matchesKey(data, "return") || matchesKey(data, "space")) {
			pick = this.presetSelected;
		} else if (/^[1-9]$/.test(data)) {
			pick = Number(data) - 1;
		}
		if (pick >= 0 && pick < PRESETS.length) {
			this.presetMode = false;
			this.callbacks.onPreset(PRESETS[pick]);
		}
	}

	private clampScroll(): void {
		const visible = Math.min(BODY_MAX_ROWS, this.rows.length);
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - visible)));
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
		const title = this.presetMode ? "Context Token Usage — presets" : `Context Token Usage (${this.mode})`;
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
						? "↑↓ move · <enter> apply · <1-5> quick apply · <esc> back"
						: "↑↓ move · ←→ fold · <space> mask/unmask · <tab> raw/effective · <p> presets · <i> input · <esc> close",
				),
			),
		);
		lines.push(boxRow(th.fg("borderMuted", "─".repeat(innerW - 2))));

		// Body
		if (this.presetMode) {
			for (let i = 0; i < PRESETS.length; i++) {
				lines.push(this.renderPresetRow(i, i === this.presetSelected, innerW));
			}
			lines.push(boxRow(th.fg("dim", `(${this.presetSelected + 1}/${PRESETS.length})`)));
			lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
			return lines;
		}
		this.clampScroll();
		const visible = Math.min(BODY_MAX_ROWS, this.rows.length);
		for (let i = this.scroll; i < this.scroll + visible; i++) {
			const row = this.rows[i];
			if (!row) break;
			lines.push(this.renderRow(row, i === this.selected, innerW));
		}

		// Footer position indicator
		lines.push(boxRow(th.fg("dim", `(${this.rows.length === 0 ? 0 : this.selected + 1}/${this.rows.length})`)));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	private renderPresetRow(index: number, isSelected: boolean, innerW: number): string {
		const th = this.theme;
		const preset = PRESETS[index];
		const num = th.fg("warning", `${index + 1}.`);
		const label = th.fg("text", preset.label);
		let line = `  ${num} ${label}`;
		line += " ".repeat(Math.max(0, innerW - visibleWidth(line)));
		if (isSelected) line = th.bg("selectedBg", line);
		return th.fg("border", "│") + line + th.fg("border", "│");
	}

	private renderRow(row: Row, isSelected: boolean, innerW: number): string {
		const th = this.theme;
		const { node } = row;
		const partial = !node.masked && node.effectiveTokens < node.rawTokens;

		const marker = node.masked ? "✕" : partial ? "◐" : "○";
		const indent = "  ".repeat(row.depth);
		const fold = node.isLeaf ? " " : this.expanded.has(node.id) ? "▾" : "▸";

		const labelW = Math.max(10, innerW - COUNT_COL - TOKEN_COL - 12);
		let label = node.label || "(empty)";
		if (visibleWidth(indent + label) > labelW) {
			label = `${label.slice(0, Math.max(1, labelW - visibleWidth(indent) - 1))}…`;
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

		const left = `${indent}${fold} ${markerColored} ${labelColored}`;
		const pad = " ".repeat(Math.max(1, labelW - visibleWidth(`${indent}${fold} ${marker} ${label}`)));
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
