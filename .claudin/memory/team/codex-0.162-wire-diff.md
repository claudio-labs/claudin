---
name: codex-0.162-wire-diff
description: Codex CLI 0.162.1 vs Claudin on the Codex backend — the reasoning replay gap found 2026-10-16 and closed on branch feat/codex-reasoning-replay (10-17); final capture, gates, and the traps the capture caught
type: project
---

**Found 2026-10-16** (mitmproxy, same ChatGPT account on both arms, gpt-5.6-terra, effort
medium, the three `--hard` prompts): Claudin never asked for `reasoning.encrypted_content`
and never replayed reasoning; codexShim's stream loop ignored `reasoning` output items.

**Closed 2026-10-17** on branch `feat/codex-reasoning-replay` (killswitch
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

Still different on purpose: WebSocket + `previous_response_id` (Codex) vs HTTP with full
input, and Codex's "responses_lite" prompt shape (one `exec` tool, developer messages).

**Facts the capture and probes established:**
- A ChatGPT account accepts only gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna (272k window,
  128k out, effort low..max; `ultra` on terra is sent by Codex CLI as `high`). The others
  answer 400 "not supported when using Codex with a ChatGPT account".
  `GET /backend-api/codex/models?client_version=0.162.1` lists them (400 without it).
- The backend rejects a bad reasoning replay with HTTP 200 + one SSE `error` event,
  `code: invalid_encrypted_content`, no completion. A synthetic `fc_` call id makes the
  completed response's `output` come back empty.
- The first final capture still sent calls under synthetic ids: `normalizeMessagesForAPI`
  rebuilds every tool_use from its standard fields (only Gemini's `extra_content` and now
  `codex` survive). Unit tests passed because none rendered a tool_use under Codex.

**How to apply:** re-run `scripts/bench/ab/codex-wire-capture.ts --arm=claudin-off` (needs
mitmdump with its CA, a logged-in Codex CLI, a fresh build) whenever Codex CLI or codexShim
changes; `scripts/bench/tokens/codex-reasoning-replay-probe.ts` re-asks the backend the
replay's design questions. The runner deletes each flow file (the only copy of the token).
For a provider-switch check, an Anthropic profile's `baseUrl` is NOT used by the SDK: set
`ANTHROPIC_BASE_URL` to the mock and run `claudindev --bare`, or the request reaches the
real API. Recipe for other Rust CLIs: [[mitmproxy-rust-binary-recipe]].
