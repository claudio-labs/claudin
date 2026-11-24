---
name: codex-wire-capture-history
description: The dated Codex backend captures behind codex-0.162-wire-diff — the 10-16/17 replay tables (#307), the WebSocket capture (#308), the 10-17 review round's five bugs, and the 11-23 re-capture against Codex CLI 0.171 with its numbers
type: project
---

The evidence behind [[codex-0.162-wire-diff]], which holds the facts that came out of it.

**Found 2026-10-16** (mitmproxy, same ChatGPT account on both arms, gpt-5.6-terra, effort
medium, the three `--hard` prompts): Claudin never asked for `reasoning.encrypted_content`
and never replayed reasoning; codexShim's stream loop ignored `reasoning` output items.

**Closed 2026-10-17** in PR 307, branch `feat/codex-reasoning-replay` (killswitch
`CLAUDIN_CODEX_REASONING_REPLAY=0`). Final capture, same setup, three arms:

| | Codex 0.162.1 | Claudin | Claudin, killswitch |
|---|---|---|---|
| `include` | encrypted_content | encrypted_content | absent |
| `reasoning` | `{effort, context:"all_turns"}` | same | `{effort}` |
| `text` | `{verbosity:"low"}` | same | absent |
| `parallel_tool_calls` | false | true (kept on purpose) | true |
| reasoning items replayed per request | 0 0 2 3 0 | 0 1 1 2 3 4 | all 0 |
| messages with id + phase / calls under the backend id | 5/5, 2/2 | 5/5, 10/10 | 0/5, 0/5 |

Answers identical on all arms; zero 4xx; cache 26.1k→27.1k of ~27k. `codexplan` →
gpt-6-luna with `effort:"max"`: 200. A Codex session resumed under Anthropic sent no
`codex` field, no encrypted payload, standard tool_use blocks, no retry. The Anthropic
wire (`wire-diff --raw`) is byte-identical to main's after normalizing session UUIDs.

**Transport closed 2026-10-17** in #308. Capture with `--arm=claudin-http`: 3/6 requests as
deltas (input items `1 1 1 9 12 1` vs HTTP `1 4 6 9 12 15`), cached/input 131584/162798 vs
131584/162816 (resume turns included), answers equal, no 4xx. One-run A/B (5 reads): http
24.1 s, placebo 22.5 s, ws 10.0 s — not a measurement. The test account is a **free plan**:
its 30-day window ran out during these checks (`usage_limit_reached`, resets ~2026-11-15).

**Review round (10-17):** three agents (conventions, design, bugs) found five real bugs the
captures missed, all fixed in the PR with red tests first: a blank assistant turn after a
switch to Anthropic, an empty thinking pane per reasoning item, `codexplan` without `max`,
`codexplan` behind a relay on the 128k fallback, and a recovered stream error stopping the
replay. Left as documented limits in `codex/items.ts`: the refusal latch is per process (a
resumed session with refused items pays one failed request; a late refusal from a second
agent drops the items captured in between). Not done, by choice: moving the replay into
`codex/replay.ts` and renames. Fetching `/codex/models` instead of the static 3-model list,
also left out then, was done on 2026-11-24 ([[codex-model-list-per-account]]).

## Re-capture 2026-11-23 (Codex CLI 0.171.0, main e3c2fca0)

Same runner, gpt-5.6-terra, effort medium, arms codex + claudin (both WebSocket). Answers
equal on all three turns. Thinking is at parity: `include`, `reasoning`
`{effort, context:"all_turns"}` and `text` match; reasoning replayed per request is `0 0 2 3 0`
on both; ids/phases on every replayed message, calls 2/2 under backend ids; reasoning
tokens 288 (Codex) vs 348. History growth over the 5 requests: +823 vs +873 tokens.
- **Context per request:** Claudin ~28k (39 tools, 18.6k-char instructions), Codex ~14k.
  Since 0.171 Codex sends no top-level `instructions`/`tools`: one `additional_tools` input
  item (namespaces `functions`, `collaboration`), four developer messages, a new
  `access_programs:{cyber:"standard"}` field.
- **Cache:** 90% (Codex) vs 78% (Claudin) over the session. Claudin's first request read 0 of
  28k; Codex's first came 72% warm (9984/13834) on an account unused for 30 days. From the
  2nd request on, Claudin 97% vs Codex 94%. A fresh `-p` session is cold again (27919 in,
  0 read).
- **Quota:** the capture's ~16 mostly warm requests cost ~0.45% each of the free window; cold
  ~26k requests cost ~2.4% each.
- A 1.3k-token request reported no cache write, so the default write tier is unmeasured.
