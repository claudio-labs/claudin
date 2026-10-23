---
name: codex-0.162-wire-diff
description: Codex CLI 0.162/0.163 vs Claudin on the Codex backend — reasoning replay (#307) and WebSocket transport (#308) closed 10-17, both in v1.1.46; captures, gates, the free-plan quota that ran out, the traps the captures caught; the rate-limit wire (x-codex-* headers over HTTP, codex.rate_limits event over the socket) confirmed live 10-22
type: project
---

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

Still different on purpose: Codex's "responses_lite" prompt shape (one `exec` tool, developer
messages), its `generate: false` prewarm and its telemetry (`x-codex-turn-metadata`,
`client_metadata` in every frame).

**Transport closed 2026-10-17** in #308 (killswitch `CLAUDIN_CODEX_WEBSOCKET=0`; design in
`docs/tech/responses-websocket/README.md`; the defaults and what was rejected are in
[[codex-backend-speaks-codex-cli-wire]]). Claudin
talks to the backend over a socket with deltas, like Codex CLI 0.163. Capture with
`--arm=claudin-http`: 3/6 requests as deltas (input items `1 1 1 9 12 1` vs HTTP
`1 4 6 9 12 15`), cached/input 131584/162798 vs 131584/162816 (resume turns included),
answers equal, no 4xx. One-run A/B (5 reads): http 24.1 s, placebo 22.5 s, ws 10.0 s —
not a measurement. The test account is a **free plan**: its 30-day window ran out during
these checks (`usage_limit_reached`, resets ~2026-11-15). Over the socket that limit came
as an `error` frame read as a 500 and retried 11 times; fixed (the frame's `status` is
now the Response's).

**Facts the capture and probes established:**
- A ChatGPT account accepts only gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna (272k window,
  128k out, effort low..max; `ultra` on terra is sent by Codex CLI as `high`). The others
  answer 400 "not supported when using Codex with a ChatGPT account".
  `GET /backend-api/codex/models?client_version=0.162.1` lists them (400 without it).
- The backend rejects a bad reasoning replay with HTTP 200 + one SSE `error` event,
  `code: invalid_encrypted_content`, no completion. A synthetic `fc_` call id makes the
  completed response's `output` come back empty.
- The first final capture still sent calls under synthetic ids (0 of 10) with every unit
  test green; the cause and the testing lesson are in `.claudin/rules/testing.md`,
  "Provider-private block state goes through the whole render".

**Review round (10-17):** three agents (conventions, design, bugs) found five real bugs the
captures missed, all fixed in the PR with red tests first: a blank assistant turn after a
switch to Anthropic, an empty thinking pane per reasoning item, `codexplan` without `max`,
`codexplan` behind a relay on the 128k fallback, and a recovered stream error stopping the
replay. Left as documented limits in `codex/items.ts`: the refusal latch is per process (a
resumed session with refused items pays one failed request; a late refusal from a second
agent drops the items captured in between). Not done, by choice: moving the replay into
`codex/replay.ts`, renames, and fetching `/codex/models` instead of the static 3-model list.

**How to apply:** re-run `scripts/bench/ab/codex-wire-capture.ts --arm=claudin-off` (needs
mitmdump with its CA, a logged-in Codex CLI, a fresh build) whenever Codex CLI or codexShim
changes; `scripts/bench/tokens/codex-reasoning-replay-probe.ts` re-asks the backend the
replay's design questions. The runner deletes each flow file (the only copy of the token).
The provider-switch check against a mock is in testing.md (same section). Recipe for other
Rust CLIs: [[mitmproxy-rust-binary-recipe]].

## Rate-limit wire (confirmed 2026-10-22)

Confirmed with two short real requests on the free plan, which read 0% used beforehand. The
probe was a temporary `bun test` file (for the bunfig preload, with `globalThis.MACRO` set) that
called `performCodexRequest` once with `CLAUDIN_CODEX_WEBSOCKET=0` and once with the socket on.
It printed only the `x-codex-*` headers and the `codex.rate_limits` events, and was deleted
afterwards.
- **HTTP:** every response carries `x-codex-primary-{used-percent,window-minutes,reset-at,
  reset-after-seconds}` (plus `secondary-*` when the plan has a second window),
  `x-codex-plan-type` and `x-codex-credits-*`.
- **WebSocket:** the Response carries none of those. The limits arrive as a streamed
  `codex.rate_limits` event: `{plan_type, rate_limits:{primary:{used_percent, window_minutes,
  reset_at}, secondary:null}, credits}`. Here `rate_limits` is ONE snapshot, not the collection
  `normalizeCodexUsagePayload` parses from `/backend-api/wham/usage`.
- **Free plan:** one 30-day window (`window_minutes` 43200). On 10-22 `wham/usage` said it resets
  2026-11-21.
- **Reset drift:** `reset_at` drifts a few seconds between responses within one window. Anything
  that keys a window on its reset instant needs a tolerance; the branch uses 5 min.
- **From codex-rs source, never captured:**
  - Codex CLI warns at used-percent `[50,75,90,95]`, once per threshold per window. The floor is
    50 for Plus/Team on the ~5h window and 75 otherwise.
  - A 429 with `error.type: "usage_limit_reached"` carries `plan_type`, `resets_at` (unix
    seconds) and `limit_window_minutes`.
  - Claudin's limit-reached reader (`codex-usage-limit` in `rateLimitInfo.ts`, from
    `feat/usage-by-provider`) is built on that body without ever having seen one live.
- **No local mock:** a profile pointed at a local base URL resolves to the OpenAI-compatible
  transport, not `codex_responses`, so the shim's recording never runs against a mock. The live
  path needs the real backend.
