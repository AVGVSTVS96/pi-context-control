# pi-context-control

Interactive context window manager for [pi](https://pi.dev). See exactly what is in your LLM context — every message, reasoning block, tool call, and tool result, with token estimates — and mask any of it in or out of context at will.

Masking is **non-destructive**: it is applied via pi's `context` event right before each LLM call. The session file is never modified, and everything is reversible at any time.

## Usage

Run `/ctx` (or `ctrl+alt+c`) to open the panel:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Context Token Usage (effective)                                      │
│ messages: 21 · tokens: 16.5K raw · 10.5K masked out · 6.0K effective │
│ ↑↓ move · ←→ fold · <space> mask/unmask · <tab> raw/effective · …    │
│ ──────────────────────────────────────────────────────────────────── │
│ ▾ ○ assistant                                  7x       5_556 tokens │
│   ▸ ○ reasoning                                6x       5_304 tokens │
│   ▸ ○ text                                     7x          90 tokens │
│   ▾ ○ tool-call                               12x         162 tokens │
│     ▸ ○ bash                                   6x          96 tokens │
│     ▸ ○ read                                   6x          66 tokens │
│ ▾ ○ user                                       2x          28 tokens │
│ ▾ ✕ tool                                      12x         420 tokens │
│   ▾ ✕ tool-result                             12x         420 tokens │
╰──────────────────────────────────────────────────────────────────────╯
```

- The tree groups context by role → content type → tool, expandable down to individual messages.
- `space` masks/unmasks the selected node (a whole group or a single message). Masking a group covers everything under it; unmasking a child under a masked group automatically splits the group mask so only that child comes back.
- `tab` switches the token column between **raw** (what the history costs unmasked) and **effective** (what will actually be sent after masking).
- `p` opens the preset menu: hide tool results older than 2/5 turns, hide all tool results, hide all reasoning, clear all masks. Presets are one-shot batches (a batch breaks the prompt cache once; a live rule would break it every turn) and mask individual leaves, so newer results stay visible and anything can be unmasked by hand.
- `i` returns focus to the editor while the panel stays open above the input; `/ctx` focuses it again. `esc` closes it.
- Mask state persists in the session (as a `custom` entry pi never sends to the model) and is restored on `/resume`.

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

Token counts are estimates (chars/4, matching pi's own estimator, plus a correction for encrypted thinking signatures which cost ~chars, not chars/4).

## Install

```bash
# from a project's .pi/settings.json or ~/.pi/settings.json
{ "packages": ["path/to/pi-context-control"] }
```

## Roadmap

- ~~Phase 2 (QoL)~~ shipped: usage widget + footer status, mask presets, richer stubs.
- Phase 3 (cache awareness): visualize prompt-cache impact of masking. Caching is prefix-based, so masking any item invalidates the cache for everything after it — the suffix is rewritten to cache on the next call, then the smaller prefix caches again and the savings recur every call. Planned: per-node impact preview when selected ("saves ~X/call · breaks ~Y cached · pays off after ~N calls"), a pending-changes line showing the earliest cache-break point (batched masks break the cache once), a tree marker at that boundary, and real `cacheRead`/`cacheWrite` numbers from pi's recorded usage to keep estimates honest.
- Phase 4 (summarization): non-destructive summarization — swap a masked span for a generated summary at send time, integrate with pi compaction.
