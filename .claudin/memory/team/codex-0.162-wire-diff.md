---
name: codex-0.162-wire-diff
description: What the ChatGPT Codex backend accepts and sends, from captures against Codex CLI 0.162–0.172 (10-16 → 11-24) — replay and WebSocket at parity, the per-plan model list, quota weights, the rate-limit wire, and how to re-capture; the dated tables are in codex-wire-capture-history
type: project
---

Claudin's Codex backend wire matches the Codex CLI where it matters: reasoning replay (#307,
killswitch `CLAUDIN_CODEX_REASONING_REPLAY=0`) and the WebSocket transport with deltas (#308,
`CLAUDIN_CODEX_WEBSOCKET=0`; design in `docs/tech/responses-websocket/README.md`, defaults and
rejections in [[codex-backend-speaks-codex-cli-wire]]). Both closed 2026-10-17 and were
re-captured at parity on 2026-11-23 against 0.171. The capture tables, the numbers and the 10-17
review round are in [[codex-wire-capture-history]].

Still different on purpose: Codex's "responses_lite" prompt shape (one `exec` tool, developer
messages; since 0.171 one `additional_tools` input item and no top-level `instructions`/`tools`),
its `generate: false` prewarm, its telemetry (`x-codex-turn-metadata`, `client_metadata` in every
frame), and `parallel_tool_calls` (Codex false, Claudin true).

**Facts the captures and probes established:**
- The FREE test account accepts only gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna (272k window,
  128k out, effort low..max; `ultra` on terra is sent by Codex CLI as `high`). The others
  answer 400 "not supported when using Codex with a ChatGPT account".
  `GET /backend-api/codex/models?client_version=…` lists them (400 without it). The list
  depends on the plan: paid plans also get gpt-6.2-*. Since 2026-11-24 Claudin reads it at
  startup ([[codex-model-list-per-account]]); a live GET at 0.172.0 that day returned the
  same three.
- The backend rejects a bad reasoning replay with HTTP 200 + one SSE `error` event,
  `code: invalid_encrypted_content`, no completion. A synthetic `fc_` call id makes the
  completed response's `output` come back empty.
- The first final capture still sent calls under synthetic ids (0 of 10) with every unit
  test green; the cause and the testing lesson are in `.claudin/rules/testing.md`,
  "Provider-private block state goes through the whole render".
- Over the socket, `usage_limit_reached` arrives as an `error` frame; it was read as a 500 and
  retried 11 times until fixed (the frame's `status` is now the Response's).
- **Context and cache (11-23):** Claudin sends ~28k per request, Codex ~14k. Session cache 78%
  vs 90%, and the whole gap is Claudin's cold first request: Codex's first comes ~72% warm, so
  its static prefix seems warm server-side. From the 2nd request on Claudin leads, 97% vs 94%.
  Making a new session warm was probed and rejected: [[codex-cross-session-prefix-rejected]].
- **Quota weights (free plan, 11-23):** a warm request costs ~0.45% of the 30-day window, a cold
  ~26k one ~2.4% (cached input weighs ~1/7). That is why the keep-alive kept its ping, capped:
  [[codex-keepalive-ping-capped]].
- **Usage fields new on the backend:** `input_tokens_details.cache_write_tokens_details`
  `{ttl_30m_tokens, ttl_12h_tokens}` and a per-item `attribution` block; the default write tier
  is unmeasured.
- Claudin also sends the classifier capability probe (forced `classify_result`, 124 tokens)
  under `--dangerously-skip-permissions`.

**How to apply:** re-run `scripts/bench/ab/codex-wire-capture.ts --arm=claudin-off` (needs
mitmdump with its CA, a logged-in Codex CLI, a fresh build) whenever Codex CLI or codexShim
changes; `scripts/bench/tokens/codex-reasoning-replay-probe.ts` re-asks the backend the
replay's design questions. The runner deletes each flow file (the only copy of the token).
The provider-switch check against a mock is in testing.md (same section). Recipe for other
Rust CLIs: [[mitmproxy-rust-binary-recipe]].

To see what an account is offered, without quota: it is one GET with no model call. Two ways:
- **A scratch script.** Set `globalThis.MACRO`, call `enableConfigs()`, and take the Codex
  profile from `getGlobalConfig().providerProfiles`. Credentials come from
  `refreshCodexAccessTokenIfNeeded({ profile })` + `resolveRuntimeCodexCredentials`. Then
  send the request `codexModelRefresh.ts` builds and print `toCodexAccountModels(body.models)`,
  slugs only.
- **The TUI.** Run `claudindev` in tmux, with `CLAUDIN_CONFIG_DIR` pointing at a copy of
  that one profile, and open `/model`.

Codex CLI's own copy is `~/.codex/models_cache.json`, and the full bundled catalog (every
plan, `available_in_plans`, `minimal_client_version`) is a JSON object inside its binary
(`"slug": "gpt-6.2-sol"`).

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
