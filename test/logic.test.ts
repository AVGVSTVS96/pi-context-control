/** Logic smoke tests for pi-context-control masking + trees (no pi runtime needed). */
import { cacheCosts, DEFAULT_CACHE_COSTS, diffAgainstSnapshot, editImpact, sentStream } from "../extensions/context-control/cache.ts";
import { sendPlan, summarizeSpanEdit, toggleNodeEdit, toggleSummaryEdit } from "../extensions/context-control/plan.ts";
import { applySummaries, canonicalSpan, generateSpanSummary, parseModelSpec, spanLeafIds, spanMessages, SummaryStore, summaryNodeId, summaryTokens } from "../extensions/context-control/summaries.ts";
import { applyMask, MaskState, toggleNodeMask } from "../extensions/context-control/masking.ts";
import { buildSessionTree, buildTree } from "../extensions/context-control/tree.ts";
import { indexLeaves, maskedLeafCount, pruneStaleMasks } from "../extensions/context-control/leaves.ts";
import { applyRule, PRESETS, toPreset } from "../extensions/context-control/presets.ts";
import type { AnyMessage } from "../extensions/context-control/keys.ts";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.error(`FAIL: ${name}`, extra ?? "");
	} else {
		console.log(`ok: ${name}`);
	}
}

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;

function nodeMap(tree: ReturnType<typeof buildTree>): Map<string, any> {
	const byId = new Map<string, any>();
	const walk = (n: any) => { byId.set(n.id, n); n.children.forEach(walk); };
	tree.roots.forEach(walk);
	return byId;
}

const messages: AnyMessage[] = [
	{ role: "user", content: "hello there", timestamp: 1000 },
	{
		role: "assistant",
		timestamp: 2000,
		content: [
			{ type: "thinking", thinking: "let me think about this problem", thinkingSignature: "x".repeat(100) },
			{ type: "text", text: "I will read the file now." },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { file_path: "/a.ts" } },
			{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls -la" } },
		],
	},
	{ role: "toolResult", timestamp: 3000, toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file contents ".repeat(200) }] },
	{ role: "toolResult", timestamp: 3001, toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "total 42\ndrwxr" }] },
	{ role: "user", content: [{ type: "text", text: "and an image" }, { type: "image", data: "...", mimeType: "image/png" }], timestamp: 4000 },
];
const idx = indexLeaves(messages);

// --- leaf index + unmasked trees ---
{
	const state = new MaskState();
	const tree = buildTree(idx, state);
	const byId = nodeMap(tree);

	check("message count", tree.messageCount === 5);
	check("assistant count = messages", byId.get("assistant")?.count === 1);
	check("tool-call count = blocks", byId.get("assistant.tool-call")?.count === 2);
	check("read call group exists", byId.get("assistant.tool-call.read")?.count === 1);
	check("tool results grouped", byId.get("tool.tool-result")?.count === 2);
	check("user image leaf", byId.get("user.image")?.rawTokens === 1500);
	check("raw == effective when unmasked", tree.rawTotal === tree.effectiveTotal);
	check("thinking sig counted", byId.get("assistant.reasoning")!.rawTokens > 100);

	const session = buildSessionTree(idx, state);
	const sById = nodeMap(session);
	check("two turns", session.roots.length === 2);
	check("turn 1 keyed by user msg", session.roots[0].id === "turn:user:1000:");
	check("turn label from user text", session.roots[0].label.includes("hello there"), session.roots[0].label);
	check("turn 1 message count", session.roots[0].count === 4); // user + assistant + 2 results
	check("pair rows under turn 1", sById.get("pair:tc1") && sById.get("pair:tc2"));
	check("pair holds call + result", sById.get("pair:tc1")!.children.length === 2);
	check("pair count = 1 exchange", sById.get("pair:tc1")!.count === 1);
	check("session totals match general", session.rawTotal === tree.rawTotal && session.effectiveTotal === tree.effectiveTotal);
}

// --- signature-only reasoning (OpenAI encrypted payloads): labeled, counted ---
{
	const enc = indexLeaves([
		{ role: "user", content: "q", timestamp: 1 },
		{
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "y".repeat(1082) },
				{ type: "text", text: "a" },
			],
		},
	] as AnyMessage[]);
	const leaf = enc.leaves.find((l) => l.kind === "reasoning")!;
	check("encrypted-only reasoning labeled", leaf.label === "(encrypted)", leaf.label);
	check("encrypted payload counted ~1 tok/char", leaf.raw === 1082, leaf.raw);
	const withText = indexLeaves(messages);
	const labeled = withText.leaves.find((l) => l.kind === "reasoning")!;
	check("visible thinking keeps its text label", labeled.label === "let me think about this problem", labeled.label);
}

// --- mask read results: stubbed, pairing preserved ---
{
	const state = new MaskState();
	state.add("tool.tool-result.read");
	const out = applyMask(messages, state);
	check("no messages dropped when stubbing", out.length === messages.length);
	const readResult = out.find((m) => m.role === "toolResult" && m.toolName === "read") as any;
	check("read result stubbed", readResult.content[0].text.includes("hidden by the user"));
	const bashResult = out.find((m) => m.role === "toolResult" && m.toolName === "bash") as any;
	check("bash result untouched", bashResult.content[0].text.startsWith("total 42"));
	const tree = buildTree(idx, state);
	check("effective < raw after masking", tree.effectiveTotal < tree.rawTotal);
}

// --- mask read CALLS: block dropped AND paired result dropped ---
{
	const state = new MaskState();
	state.add("assistant.tool-call.read");
	const out = applyMask(messages, state);
	const assistant = out.find((m) => m.role === "assistant") as any;
	check("read call block removed", !assistant.content.some((b: any) => b.type === "toolCall" && b.name === "read"));
	check("bash call kept", assistant.content.some((b: any) => b.type === "toolCall" && b.name === "bash"));
	check("paired read result dropped", !out.some((m) => m.role === "toolResult" && (m as any).toolCallId === "tc1"));
	check("bash result kept", out.some((m) => m.role === "toolResult" && (m as any).toolCallId === "tc2"));
}

// --- mask all reasoning / whole user group ---
{
	const state = new MaskState();
	state.add("assistant.reasoning");
	const out = applyMask(messages, state);
	const assistant = out.find((m) => m.role === "assistant") as any;
	check("thinking stripped", !assistant.content.some((b: any) => b.type === "thinking"));
	check("text kept", assistant.content.some((b: any) => b.type === "text"));

	const state2 = new MaskState();
	state2.add("user");
	const out2 = applyMask(messages, state2);
	check("user messages dropped", !out2.some((m) => m.role === "user"));
}

// --- turn masking: whole section disappears ---
{
	const state = new MaskState();
	state.add("turn:user:1000:");
	const out = applyMask(messages, state);
	check("turn 1 user dropped", !out.some((m) => m.role === "user" && m.timestamp === 1000));
	check("turn 1 assistant dropped", !out.some((m) => m.role === "assistant"));
	check("turn 1 results dropped", !out.some((m) => m.role === "toolResult"));
	check("turn 2 user kept", out.some((m) => m.role === "user" && m.timestamp === 4000));
}

// --- pair masking: result stubbed, call kept ---
{
	const state = new MaskState();
	state.add("pair:tc1");
	const out = applyMask(messages, state);
	const assistant = out.find((m) => m.role === "assistant") as any;
	check("pair mask keeps the call", assistant.content.some((b: any) => b.type === "toolCall" && b.id === "tc1"));
	const readResult = out.find((m) => m.role === "toolResult" && (m as any).toolCallId === "tc1") as any;
	check("pair mask stubs the result", readResult.content[0].text.includes("hidden by the user"));
	const session = buildSessionTree(idx, state);
	const sById = nodeMap(session);
	check("pair node self-masked in session view", sById.get("pair:tc1")!.selfMasked);
	check("call leaf not masked under pair", !sById.get("call:tc1")!.masked);
	check("result leaf masked under pair", sById.get("result:tc1")!.masked);
}

// --- explode-unmask within one view: mask "tool", unmask the read result ---
{
	const state = new MaskState();
	state.add("tool");
	const tree = buildTree(idx, state);
	const byId = nodeMap(tree);

	const readLeaf = byId.get("result:tc1")!;
	check("leaf covered by group mask", readLeaf.masked && !readLeaf.selfMasked);

	toggleNodeMask(state, readLeaf, idx.leaves);
	check("group mask removed", !state.has("tool"));
	check("sibling re-masked as leaf", state.has("result:tc2"));
	check("target leaf unmasked", !state.anyMasked(readLeaf.chain));

	const tree2 = buildTree(idx, state);
	const byId2 = nodeMap(tree2);
	check("read leaf effective restored", byId2.get("result:tc1")!.effectiveTokens > 100);
	check("bash leaf still masked", byId2.get("result:tc2")!.masked);
}

// --- CROSS-VIEW explode: mask a turn in session view, unmask a leaf from general view ---
{
	const state = new MaskState();
	state.add("turn:user:1000:");
	const general = buildTree(idx, state);
	const byId = nodeMap(general);
	const reasoningLeaf = byId.get("think:assistant:2000:")!;
	check("turn mask visible in general view", reasoningLeaf.masked);

	toggleNodeMask(state, reasoningLeaf, idx.leaves);
	check("turn mask exploded", !state.has("turn:user:1000:"));
	check("reasoning unmasked", !state.anyMasked(reasoningLeaf.chain));
	check("rest of turn still masked", state.anyMasked(["result:tc1"]) && state.anyMasked(["text:assistant:2000:"]));
	const out = applyMask(messages, state);
	const assistant = out.find((m) => m.role === "assistant") as any;
	check("reasoning survives, text stripped", assistant.content.some((b: any) => b.type === "thinking") && !assistant.content.some((b: any) => b.type === "text"));
}

// --- partial parent cycle: clear all → mask all → clear all ---
{
	const state = new MaskState();
	state.add("result:tc1"); // one child of "tool" masked → tool is partial
	const tree = buildTree(idx, state);
	const toolGroup = nodeMap(tree).get("tool")!;

	toggleNodeMask(state, toolGroup, idx.leaves);
	check("partial parent: first press clears children", state.size === 0);

	toggleNodeMask(state, toolGroup, idx.leaves);
	check("second press masks whole group", state.has("tool") && state.size === 1);

	toggleNodeMask(state, toolGroup, idx.leaves);
	check("third press fully unmasks, no residue", state.size === 0);
}

// --- partial via CROSS-VIEW mask: pair masked in session view, parent toggled in general view ---
{
	const state = new MaskState();
	state.add("pair:tc1"); // session-view pair mask covers result:tc1
	const general = buildTree(idx, state);
	const resultGroup = nodeMap(general).get("tool.tool-result")!;
	check("pair mask makes general group partial", resultGroup.effectiveTokens < resultGroup.rawTokens);

	toggleNodeMask(state, resultGroup, idx.leaves);
	check("clearing partial parent explodes outside pair mask", state.size === 0);
}

// --- partial turn cycle in session view ---
{
	const state = new MaskState();
	state.add("think:assistant:2000:"); // one item of turn 1 masked
	const session = buildSessionTree(idx, state);
	const turn = nodeMap(session).get("turn:user:1000:")!;

	toggleNodeMask(state, turn, idx.leaves);
	check("partial turn: first press clears the item", state.size === 0);
	toggleNodeMask(state, turn, idx.leaves);
	check("second press masks the whole turn", state.has("turn:user:1000:") && state.size === 1);
}

// --- self-masked group with leftover child masks clears in one press ---
{
	const state = new MaskState();
	state.load(["tool", "result:tc1"]); // e.g. restored session with both ids
	const tree = buildTree(idx, state);
	toggleNodeMask(state, nodeMap(tree).get("tool")!, idx.leaves);
	check("unmasking masked group also drops residual child ids", state.size === 0);
}

// --- richer stub: names the call target and previews the content ---
{
	const state = new MaskState();
	state.add("tool.tool-result.read");
	const out = applyMask(messages, state);
	const readResult = out.find((m) => m.role === "toolResult" && m.toolName === "read") as any;
	const stub = readResult.content[0].text as string;
	check("stub names the call target", stub.includes("/a.ts"), stub);
	check("stub previews the content", stub.includes('It began: "file contents'), stub);
	const tree = buildTree(idx, state);
	const byId = nodeMap(tree);
	check("tree stub estimate ≈ stub size", Math.abs(byId.get("result:tc1")!.effectiveTokens - Math.ceil(stub.length / 4)) <= 1);
}

// --- presets: rules, tunable values, user presets ---
{
	const state = new MaskState();
	// 2 turns total → nothing is older than 2 turns.
	check("older-than-2: nothing to mask", preset("stale-results").apply(state, idx, 2) === 0 && state.size === 0);

	// Third turn arrives → turn 1's results are now stale.
	const extended = indexLeaves([...messages, { role: "user", content: "next question", timestamp: 5000 } as AnyMessage]);
	check("older-than-2 masks both stale results", preset("stale-results").apply(state, extended, 2) === 2 && state.size === 2);
	check("preset masks leaves not groups", state.has("result:tc1") && state.has("result:tc2"));
	check("preset idempotent", preset("stale-results").apply(state, extended, 2) === 0);

	// Tunable value: with N=1, nothing changes (already masked); fresh state with N=1 masks turn-1 results too.
	const s2 = new MaskState();
	check("older-than-1 masks turn-1 results", preset("stale-results").apply(s2, extended, 1) === 2);

	// Size rule: only the big read result (700 tokens) exceeds 500.
	const s3 = new MaskState();
	check("larger-than-500 masks only the big result", preset("big-results").apply(s3, idx, 500) === 1 && s3.has("result:tc1"));

	// User preset: reasoning older than 1 turn.
	const s4 = new MaskState();
	const user = toPreset({ label: "old thoughts", types: ["reasoning"], olderThanTurns: 1 }, 0);
	check("user preset masks old reasoning", user.apply(s4, idx) === 1 && s4.has("think:assistant:2000:"));

	// Tool filter.
	const s5 = new MaskState();
	check("tool filter matches only bash", applyRule(s5, idx, { tools: ["bash"] }) === 1 && s5.has("result:tc2"));

	check("all-reasoning adds group mask", preset("all-reasoning").apply(state, idx) === 1 && state.has("assistant.reasoning"));
	const cleared = preset("clear").apply(state, idx);
	check("clear removes everything", cleared === 3 && state.size === 0, cleared);
}

// --- masked leaf count + stale mask pruning (widget honesty) ---
{
	const state = new MaskState();
	check("no masks → 0 items", maskedLeafCount(state, idx) === 0);

	state.add("turn:user:1000:"); // covers all of turn 1: utext + thinking + text + 2 calls + 2 results = 7
	check("turn mask counts covered leaves", maskedLeafCount(state, idx) === 7, maskedLeafCount(state, idx));

	// Armed group rule matching nothing hides nothing.
	const armed = new MaskState();
	armed.add("assistant.reasoning");
	const noReasoning = indexLeaves([{ role: "user", content: "hi", timestamp: 9000 } as AnyMessage]);
	check("armed group mask hides 0 items", maskedLeafCount(armed, noReasoning) === 0 && armed.size === 1);
	check("armed group mask survives pruning", pruneStaleMasks(armed, noReasoning) === 0 && armed.has("assistant.reasoning"));

	// Stale instance ids (content gone from the session) get pruned.
	const stale = new MaskState();
	stale.load(["turn:user:99999:", "result:tc-gone", "pair:tc-gone", "result:tc1"]);
	check("stale instance ids pruned, live ones kept", pruneStaleMasks(stale, idx) === 3 && stale.has("result:tc1") && stale.size === 1);
}

// --- cache awareness: snapshot, break detection, per-node impact ---
{
	const clean = new MaskState();
	const snap = sentStream(idx, sendPlan(clean));
	const tree = buildTree(idx, clean);
	const byId = nodeMap(tree);
	check("snapshot covers every sent leaf", snap.ids.length === idx.leaves.length && snap.total === tree.rawTotal);

	// Nothing changed → no break; appending new turns is a clean extension.
	check("no change → no break", diffAgainstSnapshot(sentStream(idx, sendPlan(clean)), snap).breakLeafId === undefined);
	const grown = indexLeaves([...messages, { role: "user", content: "next question", timestamp: 5000 } as AnyMessage]);
	const ext = diffAgainstSnapshot(sentStream(grown, sendPlan(clean)), snap);
	check("append is not a break", ext.breakLeafId === undefined && ext.brokenTokens === 0 && ext.rewrittenTokens === 0);

	// Mask the early read result → break lands exactly there.
	const masked = new MaskState();
	masked.add("result:tc1");
	const brk = diffAgainstSnapshot(sentStream(idx, sendPlan(masked)), snap);
	const pos = snap.ids.indexOf("result:tc1");
	const cachedSuffix = snap.tokens.slice(pos).reduce((a, b) => a + b, 0);
	check("break at the masked leaf", brk.breakLeafId === "result:tc1");
	check("broken = cached suffix from break", brk.brokenTokens === cachedSuffix, brk.brokenTokens);
	check("rewritten = still-sent cached suffix (stub, not raw)", brk.rewrittenTokens > 0 && brk.rewrittenTokens < cachedSuffix, brk.rewrittenTokens);

	// Masking the LAST cached item: invalidates it but rewrites nothing → free.
	const imageLeaf = byId.get("user.image")!.children[0];
	const tail = editImpact(idx, sendPlan(clean), toggleNodeEdit(imageLeaf, idx.leaves), snap);
	check("tail mask saves its size", tail.deltaPerCall === 1500);
	check("tail mask rewrites nothing → pays off immediately", tail.extraRewrittenTokens === 0 && tail.paybackCalls === 0);

	// Masking early content pays a one-time rewrite of everything after it.
	const readLeaf = byId.get("result:tc1")!;
	const early = editImpact(idx, sendPlan(clean), toggleNodeEdit(readLeaf, idx.leaves), snap);
	check("early mask saves per call", early.deltaPerCall > 0);
	check("early mask pays a rewrite", early.extraRewrittenTokens > 0 && (early.paybackCalls ?? 0) >= 1, early);

	// Behind an existing pending break, further masking adds no rewrite cost.
	const pendingState = new MaskState();
	pendingState.add("result:tc1");
	const behind = editImpact(idx, sendPlan(pendingState), toggleNodeEdit(imageLeaf, idx.leaves), snap);
	check("mask behind pending break adds no rewrite", behind.extraRewrittenTokens === 0 && behind.deltaPerCall === 1500);

	// Unmasking reports tokens added back per call.
	const unmask = editImpact(idx, sendPlan(pendingState), toggleNodeEdit(nodeMap(buildTree(idx, pendingState)).get("result:tc1")!, idx.leaves), snap);
	check("unmask adds tokens back", unmask.deltaPerCall < 0 && unmask.paybackCalls === undefined);

	// No snapshot yet (no call happened) → everything is free.
	const cold = editImpact(idx, sendPlan(clean), toggleNodeEdit(readLeaf, idx.leaves), undefined);
	check("no cache → toggles free", !cold.hasCache && cold.extraRewrittenTokens === 0 && cold.deltaPerCall > 0);

	// Tiny result whose stub costs the same tokens: the bytes still change, so
	// it must register as a break even though the size diff is zero.
	const tiny = new MaskState();
	tiny.add("result:tc2"); // "total 42\ndrwxr": stub is bigger, clamped to raw
	const tinyBrk = diffAgainstSnapshot(sentStream(idx, sendPlan(tiny)), snap);
	check("same-size stub still breaks the cache", tinyBrk.breakLeafId === "result:tc2", tinyBrk);
	const tinyImpact = editImpact(idx, sendPlan(clean), toggleNodeEdit(nodeMap(buildTree(idx, clean)).get("result:tc2")!, idx.leaves), snap);
	check("same-size stub saves nothing but rewrites", tinyImpact.deltaPerCall === 0 && tinyImpact.extraRewrittenTokens > 0, tinyImpact);

	// --- model-derived cache pricing (real registry cost tables) ---
	const anthropic = cacheCosts({ cost: { input: 15, cacheRead: 1.5, cacheWrite: 18.75 } });
	check("anthropic rates → 1.25x write / 0.1x read", anthropic.writeMult === 1.25 && anthropic.readMult === 0.1, anthropic);
	const openai = cacheCosts({ cost: { input: 2.5, cacheRead: 1.25, cacheWrite: 0 } });
	check("openai rates → zero write rate is plain-input 1x, not free", openai.writeMult === 1 && openai.readMult === 0.5, openai);
	check("no model → default costs", cacheCosts(undefined) === DEFAULT_CACHE_COSTS);
	check("free/local model → default costs", cacheCosts({ cost: { input: 0, cacheRead: 0, cacheWrite: 0 } }) === DEFAULT_CACHE_COSTS);
	check("no cache pricing → default costs", cacheCosts({ cost: { input: 1.35, cacheRead: 0, cacheWrite: 0 } }) === DEFAULT_CACHE_COSTS);

	// Same toggle, different economics: OpenAI's cheap writes and expensive
	// reads repay a break much sooner than Anthropic's.
	const earlyOpenai = editImpact(idx, sendPlan(clean), toggleNodeEdit(readLeaf, idx.leaves), snap, openai);
	check("payback uses model rates", earlyOpenai.paybackCalls !== undefined && earlyOpenai.paybackCalls < early.paybackCalls!,
		{ openai: earlyOpenai.paybackCalls, anthropic: early.paybackCalls });
	const expected = Math.ceil((earlyOpenai.extraRewrittenTokens * (1 - 0.5)) / (earlyOpenai.deltaPerCall * 0.5));
	check("payback math matches derived rates", earlyOpenai.paybackCalls === expected, earlyOpenai);
	check("token math unchanged by pricing", earlyOpenai.deltaPerCall === early.deltaPerCall && earlyOpenai.extraRewrittenTokens === early.extraRewrittenTokens);
}

// --- serialization round trip ---
{
	const state = new MaskState();
	state.add("assistant.reasoning");
	state.add("result:tc1");
	const state2 = new MaskState();
	state2.load(state.toJSON());
	check("persist round trip", state2.has("assistant.reasoning") && state2.has("result:tc1"));
}

// --- span summarization: store, transforms, cache integration, generation ---
{
	const turn1 = idx.leaves.filter((l) => l.turnId === "turn:user:1000:").map((l) => l.id);
	check("fixture turn 1 has 7 leaves", turn1.length === 7, turn1);

	// Span collection: pairs stay atomic, summary rows are transparent.
	const span1 = spanLeafIds([{ id: "call:tc1", isLeaf: true, children: [] }]);
	check("call pulls its result into the span", span1.includes("result:tc1"), span1);
	check("result pulls its call into the span", spanLeafIds([{ id: "result:tc2", isLeaf: true, children: [] }]).includes("call:tc2"));
	check("summary rows are transparent to spans", spanLeafIds([{ id: "sum:r9", isLeaf: true, children: [] }, { id: "call:tc1", isLeaf: true, children: [] }]).join(",") === "call:tc1,result:tc1");
	check("canonical span orders + drops ghosts", canonicalSpan(["result:tc1", "ghost:1", "call:tc1"], idx).join(",") === "call:tc1,result:tc1");

	const rec = { id: "r1", leafIds: turn1, text: "User greeted; agent read /a.ts and listed the dir.", model: "test/m", active: true, createdAt: 4500 };
	const digest = summaryTokens(rec);
	check("digest priced with its framing", digest > 10 && digest === Math.ceil((`[Earlier context was replaced by this summary (context-control). Ask the user to restore the originals if you need them.]\n${rec.text}`).length / 4));

	const clean = new MaskState();

	// applySummaries: whole turn collapses to one digest message, later content untouched.
	const out = applySummaries(messages, [rec]);
	check("digest replaces the whole span", out.length === 2, out.map((m) => m.role));
	check("digest injected at the span position", out[0].role === "user" && String((out[0].content as any)[0].text).includes(rec.text));
	check("later content passes by reference", out[1] === messages[4]);
	check("no orphan tool results survive", !out.some((m) => m.role === "toolResult"));

	// Skeleton span: user question + final assistant text stay verbatim, middle swaps.
	const midRec = { ...rec, id: "r2", leafIds: canonicalSpan(["think:assistant:2000:", "call:tc1", "call:tc2", "result:tc1", "result:tc2"], idx) };
	const outMid = applySummaries(messages, [midRec]);
	check("skeleton: question survives verbatim", outMid[0] === messages[0]);
	check("skeleton: digest sits before the assistant message", outMid[1].role === "user" && outMid[2].role === "assistant", outMid.map((m) => m.role));
	check("skeleton: final text kept, middle gone", (outMid[2].content as any[]).length === 1 && (outMid[2].content as any[])[0].type === "text");
	check("skeleton: results dropped, turn 2 intact", outMid.length === 4 && outMid[3] === messages[4], outMid.length);

	// spanMessages: the generation input is exactly the covered content.
	const excerpt = spanMessages(messages, new Set(midRec.leafIds));
	check("excerpt keeps covered blocks only", excerpt.length === 3 && (excerpt[0].content as any[]).length === 3, excerpt.length);
	check("excerpt keeps both results", excerpt.filter((m) => m.role === "toolResult").length === 2);

	// sentStream: the digest is one pseudo-item at the span position.
	const stream = sentStream(idx, sendPlan(clean, [rec]));
	check("digest first in the sent stream", stream.ids[0] === summaryNodeId(rec as any) && stream.tokens[0] === digest, stream.ids);
	check("stream = digest + turn 2 leaves", stream.ids.length === 3, stream.ids);

	// Cache: applying the swap breaks at the span start; once cached, it's stable.
	const snapAll = sentStream(idx, sendPlan(clean)); // last call sent everything raw
	const activate = diffAgainstSnapshot(stream, snapAll);
	check("swap breaks at the span's first leaf", activate.breakLeafId === "utext:user:1000:", activate);
	const snapSum = { ...stream }; // next call cached the digest form
	check("digest form is stable on later calls", diffAgainstSnapshot(sentStream(idx, sendPlan(clean, [rec])), snapSum).breakLeafId === undefined);

	// Restoring is priced like any other edit at the span position.
	const restore = editImpact(idx, sendPlan(clean, [rec as any]), toggleSummaryEdit("r1"), snapSum);
	check("restore adds the span back per call", restore.deltaPerCall < 0, restore);
	check("restore rewrites the cached tail", restore.extraRewrittenTokens > 0, restore);

	// Trees: § node in the right turn, covered leaves at 0, totals swap.
	const plainSession = buildSessionTree(idx, clean);
	const session = buildSessionTree(idx, clean, [rec]);
	const sBy = nodeMap(session as any);
	const sumNode = sBy.get("sum:r1");
	check("session view places the summary in turn 1", sumNode?.parent?.id === "turn:user:1000:", sumNode?.parent?.id);
	check("summary node costs its digest, raw 0", sumNode?.effectiveTokens === digest && sumNode?.rawTokens === 0);
	check("covered leaf reads 0 effective", sBy.get("result:tc1")?.effectiveTokens === 0);
	check("raw total unchanged by the swap", session.rawTotal === plainSession.rawTotal);
	const turn2raw = idx.leaves.filter((l) => l.turnId === "turn:user:4000:").reduce((a, l) => a + l.raw, 0);
	check("effective total = digest + rest", session.effectiveTotal === digest + turn2raw, session.effectiveTotal);
	const general = buildTree(idx, clean, [rec]);
	check("general view lists the summary under meta", nodeMap(general).get("meta.summary")?.children[0]?.id === "sum:r1");
	check("views agree on effective total", general.effectiveTotal === session.effectiveTotal);

	// Pending record: a generating row is visible but nothing swaps yet.
	const pend = { id: "p1", leafIds: turn1, text: "", model: "test/m", active: false, pending: true, createdAt: 5000 };
	const pendTree = buildSessionTree(idx, clean, [pend]);
	const pendNode = nodeMap(pendTree as any).get("sum:p1");
	check("pending shows a generating row", pendNode?.label.includes("generating"), pendNode?.label);
	check("pending changes nothing yet", pendTree.effectiveTotal === pendTree.rawTotal);

	// Store: applicability, span lookup, overlap replacement, persistence, pruning.
	const store = new SummaryStore();
	store.add({ ...rec });
	store.add({ ...pend });
	check("applicable skips pending", store.applicable(idx).length === 1);
	check("visible includes pending", store.visible(idx).length === 2);
	check("find by span is order-insensitive", store.findBySpan([...turn1].reverse())?.id === "r1");
	check("overlap removal spares the excepted id", store.removeOverlapping(["result:tc1"], "p1") === 1 && !store.get("r1") && !!store.get("p1"));
	store.add({ ...rec });
	const persisted = store.toJSON();
	check("persist drops pending records", persisted.length === 1 && persisted[0].pending === undefined, persisted);
	const store2 = new SummaryStore();
	store2.load(persisted);
	check("summary round trip", store2.get("r1")?.text === rec.text && store2.applicable(idx).length === 1);
	check("prune drops records missing leaves", store2.prune(indexLeaves(messages.slice(4))) === 1 && store2.all.length === 0);

	// Switched-off summaries stay visible (never lost) and cover nothing.
	const offRec = { ...rec, active: false };
	const offStore = new SummaryStore();
	offStore.add(offRec);
	check("switched-off summaries stay visible", offStore.visible(idx).length === 1 && offStore.applicable(idx).length === 0);
	const offTree = buildSessionTree(idx, clean, [offRec]);
	const offNode = nodeMap(offTree as any).get("sum:r1");
	check("off row renders masked at 0 effective", offNode?.masked === true && offNode?.effectiveTokens === 0, offNode);
	check("off summary covers nothing", offTree.effectiveTotal === offTree.rawTotal);
	const apply = editImpact(idx, sendPlan(clean, [offRec as any]), toggleSummaryEdit(offRec.id), sentStream(idx, sendPlan(clean)));
	check("applying an off summary saves per call", apply.deltaPerCall > 0, apply);
	// Re-applying a summary switches off any overlapping record instead of stacking.
	const recA = { ...rec };
	const recB = { ...rec, id: "r3", leafIds: turn1.slice(0, 3), active: false };
	toggleSummaryEdit("r3")(sendPlan(new MaskState(), [recA, recB] as any));
	check("applying switches off overlapping records", recB.active === true && recA.active === false);

	check("model spec parses provider/id", parseModelSpec("openai/gpt-4o-mini")?.provider === "openai" && parseModelSpec("openai/gpt-4o-mini")?.id === "gpt-4o-mini");
	check("model spec keeps slashes in the id", parseModelSpec("openrouter/meta/llama-3")?.id === "meta/llama-3");
	check("bad model specs rejected", parseModelSpec("gpt-4o") === undefined && parseModelSpec("/x") === undefined);
}

// --- plan edits: preview and action are the same code path ---
{
	const clean = new MaskState();
	const snapAll = sentStream(idx, sendPlan(clean));
	const turn1 = idx.leaves.filter((l) => l.turnId === "turn:user:1000:").map((l) => l.id);

	// A summarize selection is priced before the digest exists.
	const spanPrev = editImpact(idx, sendPlan(clean), summarizeSpanEdit(turn1), snapAll);
	check("span selection prices the cache rewrite", spanPrev.extraRewrittenTokens > 0, spanPrev);
	check("span selection previews a saving (upper bound)", spanPrev.deltaPerCall > 0, spanPrev);
	const turn2 = idx.leaves.filter((l) => l.turnId === "turn:user:4000:").map((l) => l.id);
	const tailPrev = editImpact(idx, sendPlan(clean), summarizeSpanEdit(turn2), snapAll);
	check("tail span rewrites nothing", tailPrev.extraRewrittenTokens === 0, tailPrev);

	// Space on a turn holding an applied summary RESTORES it; the preview must
	// price that restore, not a mask of the turn.
	const rec: any = { id: "r1", leafIds: turn1, text: "digest", model: "t/m", active: true, createdAt: 4500 };
	const turnNode = nodeMap(buildSessionTree(idx, clean, [rec]) as any).get("turn:user:1000:")!;
	const snapSum = sentStream(idx, sendPlan(clean, [rec]));
	const edit = toggleNodeEdit(turnNode, idx.leaves);
	const prev = editImpact(idx, sendPlan(clean, [rec]), edit, snapSum);
	check("preview prices the restore (adds back)", prev.deltaPerCall < 0, prev);
	check("preview never touches live state", rec.active === true && clean.size === 0);
	const live = sendPlan(clean, [rec]);
	edit(live);
	check("commit restores the summary, adds no mask", rec.active === false && clean.size === 0);
	check("preview matched what commit did", snapSum.total - sentStream(idx, live).total === prev.deltaPerCall, prev.deltaPerCall);
}

// --- generation plumbing with a fake completion (no network; async, so it runs last) ---
(async () => {
	const turn1 = idx.leaves.filter((l) => l.turnId === "turn:user:1000:").map((l) => l.id);
	let seen: any;
	const fake = (async (_m: any, context: any) => {
		seen = context;
		return { role: "assistant", content: [{ type: "text", text: "  the digest  " }], stopReason: "stop" };
	}) as any;
	const text = await generateSpanSummary(spanMessages(messages, new Set(turn1)), { maxTokens: 8192 } as any, {}, undefined, fake);
	check("generation returns the trimmed digest", text === "the digest");
	check("prompt carries the serialized excerpt", String(seen.messages[0].content[0].text).includes("hello there"), String(seen.messages[0].content[0].text).slice(0, 200));
	check("system prompt forbids continuing", String(seen.systemPrompt).includes("Do NOT continue"));
	const failing = (async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" })) as any;
	const err = await generateSpanSummary([], { maxTokens: 0 } as any, {}, undefined, failing).then(() => "", (e) => String(e));
	check("generation surfaces provider errors", err.includes("boom"), err);
})().then(() => {
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
});
