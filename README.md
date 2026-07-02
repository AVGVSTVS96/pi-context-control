# pi-context-control

Interactive context window manager for [pi](https://pi.dev). See exactly what is in your LLM context — every message, reasoning block, tool call, and tool result, with token estimates — and mask any of it in or out of context at will, either by kind (general view) or chronologically by turn (session view).

Masking is **non-destructive**: it is applied via pi's `context` event right before each LLM call. The session file is never modified, and everything is reversible at any time.

## Usage

Run `/ctx` (or `ctrl+alt+c`) to open the panel:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Context Token Usage (effective)                                      │
│ messages: 21 · tokens: 16.5K raw · 10.5K masked out (12 items) · …   │
│ ↑↓ move · ←→ fold · <space> mask/unmask · <tab> raw/effective · …    │
│ ──────────────────────────────────────────────────────────────────── │
│ ○ assistant                                    7x       5_556 tokens │
│ ├─ ○ reasoning                                 6x       5_304 tokens │
│ ├─ ○ text                                      7x          90 tokens │
│ ╰─ ○ tool-call                                12x         162 tokens │
│    ├─ ○ bash                                   6x          96 tokens │
│    ╰─ ○ read                                   6x          66 tokens │
│ ○ user                                         2x          28 tokens │
│ ✕ tool                                        12x         420 tokens │
│ ╰─ ✕ tool-result                              12x         420 tokens │
╰──────────────────────────────────────────────────────────────────────╯
```

- `v` toggles between two views of the same context and mask state:
  - **general view** — role → content type → tool ("what kinds of stuff"), as above;
  - **session view** — turn → items in chronological order ("when it happened"). A turn is the section starting at each user message. Each tool call and its result appear as one pair row (`read · /src/config/loader.ts`), expandable into call and result. A **collapsed** turn still shows its final assistant reply, elbowed off the turn's marker, so every turn reads as question → answer at a glance:

  ```
  ○ turn 1 · Please look at the config loader and fix…     20x  14_841 tokens
  ╰─ ○ assistant · Found it: parseEnv drops empty-str…       1x      24 tokens
  ◐ turn 2 · Great — write a regression test for that…       6x   1_204 tokens
  ├─ ○ user · Great — write a regression test for that…      1x      11 tokens
  ├─ ○ reasoning · A test needs the same empty-string…       1x     240 tokens
  ├─ ✕ read · /src/config/loader-0.ts                        1x      65 tokens
  │  ├─ ○ call                                               1x      11 tokens
  │  ╰─ ✕ result · export function parseConfig(env)…         1x      54 tokens
  ╰─ ○ assistant · Added tests/config-loader.test.ts…        1x      17 tokens
  ```

- Markers show mask state: **○** in context · **◐** partially masked · **✕** masked out. Folded nodes show their label in **bold**.

- `space` masks/unmasks the selected node — a group, a turn, a pair, or a single item. If anything under the node is masked, the first press unmasks it all; the next press masks the whole node. Unmasking a child under a masked group brings back only that child, and masks set in one view can be undone from the other.
  - Masking a **pair row** stubs the result but keeps the call visible; masking a **turn** removes the whole section, calls and results together.
- `tab` switches the token column between **raw** (what the history costs unmasked) and **effective** (what will actually be sent after masking).
- `p` opens the preset menu. Presets with a ‹value› are tunable with `←`/`→` before applying, and tuned values persist with the session. Presets apply once as a batch and mask individual items, so newer results stay visible and anything can be unmasked by hand.

  ```
  1. Hide tool results older than ‹2› turns  ←→
  2. Hide tool results larger than ‹2.0K› tokens  ←→
  3. Hide all tool results
  4. Hide all reasoning
  5. Clear all masks
  ```

- The panel is **cache-aware**: prompt caching is prefix-based, so any change (mask or unmask) rewrites everything after it on the next call.
  - The footer previews the selected node: `mask: saves ~1.2K/call · rewrites ~8.0K cached · pays off in ~16 calls`.
  - Unapplied changes show a pending line — batched masks break the cache once, at the earliest change: `⚡ pending: cache breaks at turn 3 · ~8.0K rewritten next call (45.2K cached now)`. The cached size is the provider's real usage number.
  - The session view draws a `┄┄ cache breaks here ┄┄` line at the break point, and the below-editor widget warns `next call rewrites ~8.0K cache` while a break is pending.
- The panel renders **in flow** between the transcript and the input, stacking with widgets from other extensions.
- `i` hands the keyboard back to the editor while the panel stays visible; `/ctx` or `ctrl+alt+c` grabs it back. `esc` closes the panel. `ctrl+c`/`ctrl+d` always pass through to pi.
- Mask state persists in the session (as a `custom` entry pi never sends to the model) and is restored on `/resume`.

### Custom presets

Define your own presets in `.pi/context-control.json` (project) or `~/.pi/context-control.json` (global); they appear after the built-ins in the menu:

```jsonc
{
  "presets": [
    { "label": "Trim heavy reads (>1 turn old)", "types": ["tool-result"], "tools": ["read"], "olderThanTurns": 1 }
  ]
}
```

Fields (all conditions ANDed): `types` (leaf kinds: `tool-result`, `tool-call`, `reasoning`, `assistant-text`, `user-text`, `user-image`, `meta`; defaults to tool results), `tools` (restrict to specific tools), `olderThanTurns`, `largerThanTokens`.

While any mask is active, a one-line widget below the editor shows what is being sent:

```
◐ context-control 6.3K of 16.5K sent (38%) · 12 masks · /ctx to manage
```

A compact `ctx 6.3K/16.5K (38%)` status is also published to the footer (visible with pi's built-in footer; custom footers decide whether to render extension statuses).

## Masking semantics

| Node | Effect on the outgoing context |
|---|---|
| tool result | Content replaced with a one-line stub naming the call target, the size hidden, and a short preview of how the result began (keeps toolCall/toolResult pairing valid) |
| tool call | Call block removed **and** its paired result dropped |
| assistant text / reasoning | Block stripped from the assistant message |
| user text / image | Block removed (message dropped if nothing remains) |
| meta (summaries, custom, bash) | Message dropped |
| pair row (session view) | Result stubbed, call kept — the exchange stays visible |
| turn (session view) | Whole section removed: calls drop and their results drop with them |

Token counts are estimates (chars/4, matching pi's own estimator, plus a correction for encrypted thinking signatures which cost ~chars, not chars/4).

## Install

```bash
# from a project's .pi/settings.json or ~/.pi/settings.json
{ "packages": ["path/to/pi-context-control"] }
```

## Roadmap

- ~~Phase 2 (QoL)~~ shipped: usage widget + footer status, mask presets, richer stubs.
- ~~Phase 3 (session view + preset control)~~ shipped: chronological turn/pair view, cross-view masking, tunable and user-defined presets.
- ~~Phase 4 (cache awareness)~~ shipped: per-node impact preview ("saves ~X/call · rewrites ~Y cached · pays off in ~N calls"), pending-changes line with the earliest break point, session-view break boundary marker, widget warning, real `cacheRead`/`cacheWrite` numbers from pi's recorded usage.
- Phase 5 (summarization): non-destructive summarization — swap a masked span for a generated summary at send time, integrate with pi compaction.
