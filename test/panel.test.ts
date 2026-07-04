/** Render-level checks: guide lines, fold-state circles, collapsed-turn assistant preview, cache markers. */
import { editImpact, sentStream } from "../extensions/context-control/cache.ts";
import { sendPlan, summarizeSpanEdit, toggleNodeEdit } from "../extensions/context-control/plan.ts";
import { canonicalSpan, spanLeafIds } from "../extensions/context-control/summaries.ts";
import { indexLeaves } from "../extensions/context-control/leaves.ts";
import { MaskState } from "../extensions/context-control/masking.ts";
import { ContextPanel } from "../extensions/context-control/panel.ts";
import { buildSessionTree, buildTree } from "../extensions/context-control/tree.ts";
import type { AnyMessage } from "../extensions/context-control/keys.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) { failures++; console.error(`FAIL: ${name}`, extra ?? ""); }
	else console.log(`ok: ${name}`);
}

const messages: AnyMessage[] = [
	{ role: "user", content: "first question", timestamp: 1000 },
	{
		role: "assistant", timestamp: 2000,
		content: [
			{ type: "thinking", thinking: "hmm", thinkingSignature: "x".repeat(40) },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { file_path: "/a.ts" } },
		],
	},
	{ role: "toolResult", timestamp: 3000, toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "contents ".repeat(50) }] },
	{ role: "assistant", timestamp: 4000, content: [{ type: "text", text: "Here is my answer to the first question." }] },
	{ role: "user", content: "second question", timestamp: 5000 },
	{ role: "assistant", timestamp: 6000, content: [{ type: "text", text: "Second answer." }] },
];

const idx = indexLeaves(messages);
const state = new MaskState();
const models = { general: buildTree(idx, state), session: buildSessionTree(idx, state) };

const fakeTui = { requestRender() {} } as any;
const fakeTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as any;

const snapshot = sentStream(idx, sendPlan(state)); // as if the last call sent everything unmasked
const noImpact = () => ({ deltaPerCall: 0, extraBrokenTokens: 0, extraRewrittenTokens: 0, hasCache: false });
const panel = new ContextPanel(fakeTui, fakeTheme, models, [], {}, {
	onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
	onImpact: (node) => editImpact(idx, sendPlan(state), toggleNodeEdit(node, idx.leaves), snapshot),
});

// Remove only the box border (first + last char of body rows), keep guide chars.
const strip = (lines: string[]) =>
	lines.map((l) => (l.startsWith("│") ? l.slice(1, -1) : "").replace(/\s+$/, ""));
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";

// Session view: turn 1 collapsed by default (only last turn expands).
panel.handleInput("v");
const session = strip(panel.render(100));

const turn1 = session.findIndex((l) => l.includes("turn 1"));
check("collapsed turn keeps hollow circle (mask state only)", /^ ○ turn 1/.test(session[turn1] ?? ""), JSON.stringify(session[turn1]));
check("collapsed turn shows last assistant reply below", session[turn1 + 1]?.includes("assistant · Here is my answer") ?? false, session[turn1 + 1]);
check("reply elbowed under the turn marker", /^ ╰─ ○ assistant/.test(session[turn1 + 1] ?? ""), JSON.stringify(session[turn1 + 1]));
check("elbow column == turn marker column", session[turn1]?.indexOf("○") === session[turn1 + 1]?.indexOf("╰"));

const turn2 = session.findIndex((l) => l.includes("turn 2"));
check("expanded turn uses hollow circle", /^ ○ turn 2/.test(session[turn2] ?? ""), JSON.stringify(session[turn2]));
check("expanded turn 2 has tee connector rows", /^ ├─ ○ user · second question/.test(session[turn2 + 1] ?? ""), JSON.stringify(session[turn2 + 1]));
check("expanded turn's last child uses elbow", session.some((l) => /^ ╰─ ○ assistant · Second answer/.test(l)));
check("no fold carets anywhere", !session.some((l) => l.includes("▸") || l.includes("▾")));
check("no filled circles anywhere", !session.some((l) => l.includes("●")));

// Expand turn 1 → pair group nested with continued guide lines.
panel.handleInput("g");
panel.handleInput(RIGHT);
const expanded = strip(panel.render(100));
check("no duplicate reply row when expanded", expanded.filter((l) => l.includes("Here is my answer")).length === 1);
const pairLine = expanded.find((l) => l.includes("read · /a.ts"));
check("collapsed pair row keeps hollow circle", /^ ├─ ○ read · \/a\.ts/.test(pairLine ?? ""), JSON.stringify(pairLine));

// Expand the pair → children guides continue the turn level with │.
for (const key of [DOWN, DOWN, DOWN, RIGHT]) panel.handleInput(key); // turn1 → user → reasoning → pair, expand
const deep = strip(panel.render(100));
const openPair = deep.find((l) => l.includes("read · /a.ts"));
check("expanded pair stays hollow", /^ ├─ ○ read/.test(openPair ?? ""), JSON.stringify(openPair));
const callLine = deep.find((l) => l.includes("○ call"));
const resultLine = deep.find((l) => l.includes("result · contents"));
check("pair children indented under pair marker", /^ │ {2}├─ ○ call/.test(callLine ?? ""), JSON.stringify(callLine));
check("pair last child elbow", /^ │ {2}╰─ ○ result/.test(resultLine ?? ""), JSON.stringify(resultLine));

// General view guides + fold circles.
panel.handleInput("v");
const general = strip(panel.render(100));
check("general view tee/elbow connectors", general.some((l) => /^ [├╰]─ [○◐✕] /.test(l)), general.slice(5, 10));
check("general subgroup hollow circle", general.some((l) => /^ [├╰]─ ○ reasoning/.test(l)));

// --- cache awareness rendering ---
panel.handleInput("v"); // back to session view (turn 1 + pair still expanded)
panel.focused = true;
panel.setCacheStatus({
	hasSnapshot: true,
	actualCached: 5000,
	pending: { breakLeafId: "result:tc1", brokenTokens: 400, rewrittenTokens: 300, where: "turn 1" },
});
const cached = strip(panel.render(100));

check("pending line names the break turn", cached.some((l) => l.includes("pending: cache breaks at turn 1")));
check("pending line prices the rewrite", cached.some((l) => l.includes("~300 rewritten next call")));
check("pending line shows real cached size", cached.some((l) => l.includes("(5.0K cached now)")));
const boundary = cached.findIndex((l) => l.includes("cache breaks here"));
check("session view draws the break boundary", boundary >= 0);
check("boundary sits directly above the broken leaf", /╰─ [○✕] result/.test(cached[boundary + 1] ?? ""), JSON.stringify(cached[boundary + 1]));

// Footer previews the selected node's toggle impact (turn 1 selected via earlier "g").
panel.handleInput("g");
const withImpact = strip(panel.render(100));
const footer = withImpact[withImpact.length - 2] ?? ""; // last line is the box's bottom border
check("footer previews mask impact", footer.includes("mask: saves ~"), JSON.stringify(footer));
check("footer prices the cache break", footer.includes("rewrites ~") && footer.includes("pays off in ~"), JSON.stringify(footer));

// General view: no boundary line (not chronological), impact preview still there.
panel.handleInput("v");
const generalCached = strip(panel.render(100));
check("general view has no boundary line", !generalCached.some((l) => l.includes("cache breaks here")));
check("general view keeps pending line", generalCached.some((l) => l.includes("pending: cache breaks at turn 1")));

// --- fold indicators: bold labels on folded nodes, header mask count ---
// Marking theme makes styling visible: warning fg → «…», bold → ⟪…⟫.
const markTheme = {
	fg: (c: string, s: string) => (c === "warning" ? `«${s}»` : s),
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `⟪${s}⟫`,
	strikethrough: (s: string) => s,
} as any;
const state2 = new MaskState();
state2.add("result:tc1");
const panel2 = new ContextPanel(
	fakeTui,
	markTheme,
	{ general: buildTree(idx, state2), session: buildSessionTree(idx, state2) },
	[],
	{},
	{
		onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
		onImpact: (node) => editImpact(idx, sendPlan(state2), toggleNodeEdit(node, idx.leaves), snapshot),
	},
);
const marked = strip(panel2.render(100));
check("header counts masked items", marked.some((l) => l.includes("(1 item)")), marked[1]);
check("folded subgroup label bold", marked.some((l) => l.includes("├─ ○ ⟪reasoning⟫")), marked);
check("expanded group label not bold", marked.some((l) => l.includes(" ╰─ «◐» tool-result")), marked);
check("guides never highlighted", !marked.some((l) => l.includes("«├─ »") || l.includes("«╰─ »")), marked);

panel2.handleInput("v"); // session view
const markedSession = strip(panel2.render(100));
check("collapsed turn label bold (marker shows partial mask)", markedSession.some((l) => l.includes("«◐» ⟪turn 1")), markedSession);
check("preview reply not bold, plain elbow", markedSession.some((l) => l.includes(" ╰─ ○ assistant · Here is my answer")), markedSession);
check("expanded turn label not bold", markedSession.some((l) => /^ ○ turn 2/.test(l)), markedSession);

panel2.handleInput("v"); // general: fold a top-level group → bold like everything else
panel2.handleInput("G");
for (const key of [LEFT, LEFT, "G", LEFT, LEFT]) panel2.handleInput(key); // read→tool-result, collapse; re-bottom; →tool, collapse
const boldRoot = strip(panel2.render(100));
check("folded general root goes bold", boldRoot.some((l) => l.includes("◐» ⟪tool⟫") || l.includes("○ ⟪tool⟫")), boldRoot);
check("open roots stay unbolded", boldRoot.some((l) => /^ ○ assistant/.test(l)), boldRoot);

// --- span selection (s key) and summary rendering ---
{
	let summarized: any;
	let closed = false;
	const selTheme = {
		fg: (_c: string, s: string) => s,
		bg: (c: string, s: string) => (c === "selectedBg" ? `⟦${s}⟧` : s),
		bold: (s: string) => s,
		strikethrough: (s: string) => s,
	} as any;
	const panel3 = new ContextPanel(fakeTui, selTheme, { general: buildTree(idx, state), session: buildSessionTree(idx, state) }, [], {}, {
		onToggleMask() {}, onSummarize(nodes) { summarized = nodes; }, onPreset() {}, onPresetValues() {},
		onClose() { closed = true; }, onUnfocus() {},
		onImpact: (node) => editImpact(idx, sendPlan(state), toggleNodeEdit(node, idx.leaves), snapshot),
		// Wired exactly like index.ts wires it: the same edit `s` would commit.
		onSpanImpact: (nodes) => editImpact(idx, sendPlan(state), summarizeSpanEdit(canonicalSpan(spanLeafIds(nodes), idx)), snapshot),
	});
	panel3.focused = true;

	// s outside the session view: refused with a pointer.
	panel3.handleInput("s");
	const refuse = strip(panel3.render(100));
	check("s refused outside session view", refuse.some((l) => l.includes("summaries live in the session view")), refuse[refuse.length - 2]);

	panel3.handleInput("v"); // session view
	panel3.handleInput("g"); // top → turn 1
	panel3.handleInput("s"); // anchor
	const anchored = strip(panel3.render(100));
	check("anchor switches the hint", anchored.some((l) => l.includes("extend range")), anchored[2]);
	check("anchored row highlighted", anchored.some((l) => l.includes("⟦") && l.includes("turn 1")), anchored.find((l) => l.includes("turn 1")));
	check("range footer sums the span", anchored.some((l) => l.includes("summarize: ~") && l.includes("<s> to confirm")), anchored[anchored.length - 2]);
	check("range footer prices the cache rewrite", anchored.some((l) => l.includes("rewrites ~") && l.includes("cached")), anchored[anchored.length - 2]);

	panel3.handleInput(DOWN); // extend over the collapsed turn's reply row
	const extended = strip(panel3.render(100));
	check("range highlight spans both rows", extended.filter((l) => l.includes("⟦")).length >= 2, extended.filter((l) => l.includes("⟦")));
	panel3.handleInput("s"); // confirm
	check("confirm hands the range to onSummarize", summarized?.length === 2 && summarized[0].id === "turn:user:1000:", summarized?.map((n: any) => n.id));
	const after = strip(panel3.render(100));
	check("anchor cleared after confirm", after.some((l) => l.includes("<s> summarize")) && !after.some((l) => l.includes("extend range")));

	// s·s summarizes the selected row alone.
	summarized = undefined;
	panel3.handleInput("s");
	panel3.handleInput("s");
	check("s·s summarizes a single row", summarized?.length === 1, summarized?.map((n: any) => n.id));

	// esc backs out of the range without closing the panel.
	panel3.handleInput("s");
	panel3.handleInput("\x1b");
	check("esc cancels the range, panel stays open", !closed && strip(panel3.render(100)).some((l) => l.includes("<s> summarize")));

	// Applied summary: § row at the span position, restore pricing in the footer.
	const rec = {
		id: "r1",
		leafIds: idx.leaves.filter((l) => l.turnId === "turn:user:1000:").map((l) => l.id),
		text: "Digest of turn one.", model: "t/m", active: true, createdAt: 4500,
	};
	const panel4 = new ContextPanel(fakeTui, fakeTheme, { general: buildTree(idx, state, [rec]), session: buildSessionTree(idx, state, [rec]) }, [], {}, {
		onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
		onImpact: () => ({ deltaPerCall: -500, extraBrokenTokens: 800, extraRewrittenTokens: 800, hasCache: true }),
	});
	panel4.focused = true;
	panel4.handleInput("v");
	panel4.handleInput("g");
	panel4.handleInput(RIGHT); // expand turn 1
	const sumView = strip(panel4.render(100));
	check("summary row uses § marker", sumView.some((l) => /§ summary · Digest of turn one\./.test(l)), sumView.find((l) => l.includes("summary")));
	panel4.handleInput(DOWN); // summary row is turn 1's first child
	const sumFooter = strip(panel4.render(100)).slice(-2)[0] ?? "";
	check("footer offers restore pricing", sumFooter.includes("restore: adds ~500/call back") && sumFooter.includes("rewrites ~800 cached"), sumFooter);
	panel4.handleInput("s");
	const sOnSum = strip(panel4.render(100));
	check("s on a summary points to space", sOnSum.some((l) => l.includes("already a summary")), sOnSum[sOnSum.length - 2]);

	// In-flight generation: dim placeholder row, no pricing yet.
	const pend = { ...rec, id: "p1", text: "", active: false, pending: true };
	const panel5 = new ContextPanel(fakeTui, fakeTheme, { general: buildTree(idx, state, [pend]), session: buildSessionTree(idx, state, [pend]) }, [], {}, {
		onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
		onImpact: () => ({ deltaPerCall: 0, extraBrokenTokens: 0, extraRewrittenTokens: 0, hasCache: true }),
	});
	panel5.focused = true;
	panel5.handleInput("v");
	panel5.handleInput("g");
	panel5.handleInput(RIGHT);
	panel5.handleInput(DOWN);
	const genView = strip(panel5.render(100));
	check("generating row shown", genView.some((l) => l.includes("§ summary · generating…")), genView.find((l) => l.includes("summary")));
	check("footer shows summarizing…", (genView.slice(-2)[0] ?? "").includes("summarizing…"), genView.slice(-2)[0]);

	// Switched-off summary: still listed (dim + struck), space re-applies it.
	const offTheme = {
		fg: (c: string, s: string) => (c === "dim" ? `‹${s}›` : s),
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		strikethrough: (s: string) => `~${s}~`,
	} as any;
	const off = { ...rec, id: "r2", active: false };
	const panel6 = new ContextPanel(fakeTui, offTheme, { general: buildTree(idx, state, [off]), session: buildSessionTree(idx, state, [off]) }, [], {}, {
		onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
		onImpact: () => ({ deltaPerCall: 43, extraBrokenTokens: 30, extraRewrittenTokens: 30, hasCache: true }),
	});
	panel6.focused = true;
	panel6.handleInput("v");
	panel6.handleInput("g");
	panel6.handleInput(RIGHT);
	panel6.handleInput(DOWN);
	const offView = strip(panel6.render(100));
	check("off summary row stays visible, dim + struck", offView.some((l) => l.includes("‹§›") && l.includes("~summary · Digest of turn one.")), offView.find((l) => l.includes("§")));
	check("off summary footer offers apply", (offView.slice(-2)[0] ?? "").includes("apply: saves ~43/call"), offView.slice(-2)[0]);
	check("off summary hides nothing", offView.some((l) => l.includes("0 masked out")), offView[1]);

	// enter on a § row opens the digest detail view; esc backs out.
	const RETURN = "\r";
	panel4.handleInput(RETURN);
	const detail = strip(panel4.render(100));
	check("detail view titled summary digest", detail.some((l) => l.includes("summary digest")), detail[1]);
	check("detail view names the model", detail.some((l) => l.includes("generated by t/m") && l.includes("applied")), detail.find((l) => l.includes("generated by")));
	check("detail view shows the full digest", detail.some((l) => l.trim() === "│  Digest of turn one." || l.includes(" Digest of turn one.")), detail);
	check("detail view hint is scroll/back", detail.some((l) => l.includes("↑↓ scroll · <esc> back")), detail[2]);
	panel4.handleInput("\x1b");
	const backOut = strip(panel4.render(100));
	check("esc leaves the detail view, panel open", backOut.some((l) => l.includes("session view")) && backOut.some((l) => l.includes("§ summary")), backOut[1]);
	check("summary footer offers <enter> view", (backOut.slice(-2)[0] ?? "").includes("<enter> view"), backOut.slice(-2)[0]);

	// enter on a still-generating row: pointer instead of an empty view.
	panel5.handleInput(RETURN);
	const pendEnter = strip(panel5.render(100));
	check("enter on generating row explains", pendEnter.some((l) => l.includes("still generating")), pendEnter[pendEnter.length - 2]);
	check("generating row opens no detail view", !pendEnter.some((l) => l.includes("summary digest")));

	// Long digests wrap and scroll inside the detail view.
	const longText = `first line of the digest\n${"word ".repeat(60).trim()}\nlast line of the digest`;
	const long = { ...rec, id: "r4", text: longText };
	const panel7 = new ContextPanel(fakeTui, fakeTheme, { general: buildTree(idx, state, [long]), session: buildSessionTree(idx, state, [long]) }, [], {}, {
		onToggleMask() {}, onSummarize() {}, onPreset() {}, onPresetValues() {}, onClose() {}, onUnfocus() {}, onSpanImpact: noImpact,
		onImpact: () => ({ deltaPerCall: 0, extraBrokenTokens: 0, extraRewrittenTokens: 0, hasCache: false }),
	});
	panel7.focused = true;
	panel7.handleInput("v");
	panel7.handleInput("g");
	panel7.handleInput(RIGHT);
	panel7.handleInput(DOWN);
	panel7.handleInput(RETURN);
	const longView = strip(panel7.render(80));
	check("wrapped digest keeps first line", longView.some((l) => l.includes("first line of the digest")), longView[4]);
	check("long lines wrap to the panel width", longView.filter((l) => l.includes("word word")).length >= 2, longView.filter((l) => l.includes("word word")).length);
	check("wrapped digest keeps last line", longView.some((l) => l.includes("last line of the digest")));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
