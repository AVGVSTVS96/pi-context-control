# pi-context-control

Interactive context window manager for [pi](https://pi.dev). See exactly what is in your LLM context — every message, reasoning block, tool call, and tool result, with token estimates — and mask any of it in or out of context at will, either by kind (general view) or chronologically by turn (session view).

Masking is **non-destructive**: it is applied via pi's `context` event right before each LLM call. The session file is never modified, and everything is reversible at any time.

## Usage

Run `/ctx` (or `ctrl+alt+c`) to open the panel:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Context Token Usage (effective)                                      │
│ messages: 21 · tokens: 16.5K raw · 10.5K masked out · 6.0K effective │
│ ↑↓ move · ←→ fold · <space> mask/unmask · <tab> raw/effective · …    │
│ ──────────────────────────────────────────────────────────────────── │
│ ○ assistant                                    7x       5_556 tokens │
│ ├─ ● reasoning                                 6x       5_304 tokens │
│ ├─ ● text                                      7x          90 tokens │
│ ╰─ ○ tool-call                                12x         162 tokens │
│    ├─ ● bash                                   6x          96 tokens │
│    ╰─ ● read                                   6x          66 tokens │
│ ○ user                                         2x          28 tokens │
│ ✕ tool                                        12x         420 tokens │
│ ╰─ ✕ tool-result                              12x         420 tokens │
╰──────────────────────────────────────────────────────────────────────╯
```

- `v` toggles between two views of the same context and mask state:
  - **general view** — role → content type → tool ("what kinds of stuff"), as above;
  - **session view** — turn → items in chronological order ("when it happened"). A turn is the section starting at each user message. Each tool call and its result appear as one pair row (`read · /src/config/loader.ts`), expandable into call and result. A **collapsed** turn still shows its final assistant reply, elbowed off the turn's marker, so every turn reads as question → answer at a glance:

  ```
  ● turn 1 · Please look at the config loader and fix…     20x  14_841 tokens
  ╰─ ○ assistant · Found it: parseEnv drops empty-str…       1x      24 tokens
  ◐ turn 2 · Great — write a regression test for that…       6x   1_204 tokens
  ├─ ○ user · Great — write a regression test for that…      1x      11 tokens
  ├─ ○ reasoning · A test needs the same empty-string…       1x     240 tokens
  ├─ ✕ read · /src/config/loader-0.ts                        1x      65 tokens
  │  ├─ ○ call                                               1x      11 tokens
  │  ╰─ ✕ result · export function parseConfig(env)…         1x      54 tokens
  ╰─ ○ assistant · Added tests/config-loader.test.ts…        1x      17 tokens
  ```

- Circle markers carry both fold and mask state: **●** collapsed (content folded inside, `→` to open) · **○** fully shown · **◐** partially masked · **✕** masked out.

- `space` masks/unmasks the selected node — a group, a turn, a pair, or a single item. It is a clean two-state cycle: if **anything** under the node is masked (even partially, even by a mask set in the other view), the first press clears it all; the next press masks the whole node. Unmasking a child under a masked group automatically splits the group mask so only that child comes back. This works across views: mask a turn in session view, unmask one item from general view, and only that item returns.
  - Masking a **pair row** stubs the result but keeps the call visible; masking a **turn** removes the whole section (calls and results drop together, safely).
- `tab` switches the token column between **raw** (what the history costs unmasked) and **effective** (what will actually be sent after masking).
- `p` opens the preset menu. Presets with a ‹value› are tunable with `←`/`→` before applying, and tuned values persist with the session. Presets are one-shot batches (a batch breaks the prompt cache once; a live rule would break it every turn) and mask individual leaves, so newer results stay visible and anything can be unmasked by hand.

  ```
  1. Hide tool results older than ‹2› turns  ←→
  2. Hide tool results larger than ‹2.0K› tokens  ←→
  3. Hide all tool results
  4. Hide all reasoning
  5. Clear all masks
  ```

- The panel renders **in flow** between the transcript and the input (not as an overlay covering content), and stacks vertically with above-editor widgets from other extensions. The editor keeps real focus the whole time — the panel claims the keyboard via an input listener.
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
- Phase 4 (cache awareness): visualize prompt-cache impact of masking. Caching is prefix-based, so masking any item invalidates the cache for everything after it — the suffix is rewritten to cache on the next call, then the smaller prefix caches again and the savings recur every call. Planned: per-node impact preview when selected ("saves ~X/call · breaks ~Y cached · pays off after ~N calls"), a pending-changes line showing the earliest cache-break point (batched masks break the cache once), a tree marker at that boundary, and real `cacheRead`/`cacheWrite` numbers from pi's recorded usage to keep estimates honest.
- Phase 5 (summarization): non-destructive summarization — swap a masked span for a generated summary at send time, integrate with pi compaction.
