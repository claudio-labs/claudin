---
name: codex-backend-speaks-codex-cli-wire
description: Since #307/#308 (2026-10-17, shipped v1.1.46) the Codex backend replays reasoning items and talks WebSocket by default, like Codex CLI; prewarm, responses_lite, x-codex telemetry and /codex/models rejected
type: project
scope: providers/codex
impact: functional
---

**Decision:** on the ChatGPT Codex backend, Claudin copies what Codex CLI 0.162/0.163 sends wherever it changes the model's context or the transport. Two behaviors, both on by default and shipped in v1.1.46:

- **Reasoning replay (#307).** Claudin asks for `reasoning.encrypted_content` with `context:"all_turns"` and `verbosity:"low"`, and replays every reasoning item with its real ids and phase. Killswitch `CLAUDIN_CODEX_REASONING_REPLAY=0`.
- **WebSocket transport (#308).** Requests go as deltas over a pooled socket. Killswitch `CLAUDIN_CODEX_WEBSOCKET=0`.

**Why:** the mitmproxy capture of 2026-10-16 showed the model losing its own reasoning at every tool call and every turn. In the final captures:

- Answers were equal and there were zero 4xx.
- With replay, cache rose from 26.1k to 27.1k of about 27k.
- Over the socket, 3 of 6 requests went as deltas, with the same cached/input as HTTP ([[codex-0.162-wire-diff]]).

The user asked for Codex CLI parity.

**What changes for a teammate:**
- **Where Codex code lives and how it is gated.** Codex-only behavior lives in `src/providers/shims/codex/`. It is gated on the backend (`isCodexBackendRequest`, the session-level gate in `codex/backend.ts`), not on `getAPIProvider()==='codex'`. A profile with the Codex baseUrl and a non-alias model resolves as `openai`, so the provider tag would miss it.
- **No other provider may change.** `codex/providerNeutrality.invariant.test.ts` pins that and runs in `test:floor`. Diff the Anthropic wire with `wire-diff.ts` before and after.
- **The HTTP fallback is sticky for the process.** It turns on after an upgrade fails while the POST of the same request answers 2xx, or after two responses in a row lose their socket. A 401, 429 or 5xx leaves it off. The rule is in `transport/responsesSocket/transport.ts`.
- **Socket-path tests must opt in.** `bun test` sets `CLAUDIN_CODEX_WEBSOCKET=0` in `src/stubs/test-preload.ts`, so a socket-path test sets it to 1 itself.
- **Re-capture after changes.** Re-run `scripts/bench/ab/codex-wire-capture.ts` whenever Codex CLI or codexShim changes.

**Rejected:**
- **Prewarm (`generate:false`):** capture 2 showed it did not warm the first turn.
- **Codex's "responses_lite" prompt shape, the `x-codex-*` / `client_metadata` telemetry, and `codex.rate_limits`:** only the protocol is copied.
- **`parallel_tool_calls:false`:** it stays `true` on purpose, at the user's call.
- **Fetching `GET /codex/models`:** the picker is a static list of the 3 models a ChatGPT account accepts. Their 272k window applies only on the Codex transport, because changing the generic window would hit the official OpenAI API.
- **A bare `gpt-6-luna` alias:** it would switch effort on for the official API too.

**Evidence:** PRs #307 and #308; the plans `mighty-tinkering-stonebraker.md` and `majestic-sauteeing-zephyr.md`; the design in `docs/tech/responses-websocket/README.md`.
