---
name: provider-wire-protocols-2026-11
description: Branch feat/provider-wire-protocols (2026-11-28) — the four LLM wires opencode had and Claudin lacked; OpenAI/Azure GPT-5+ on the Responses API, MiniMax/Moonshot/DashScope on their /anthropic endpoints, non-Claude Bedrock on Converse, Patch as a freeform tool (off); one wire table with a sticky chat fallback; tool search moved ahead of every wire; the compiled binary's Bedrock was broken; evidence is opencode's recorded cassettes, not live accounts
type: project
scope: src/providers/presets, src/providers/shims, src/providers/transport, scripts/build
impact: functional
paths:
  - "src/providers/presets/compatWires.ts"
  - "src/providers/presets/wireFallback.ts"
  - "src/providers/shims/vendorAnthropic/**"
  - "src/providers/shims/bedrockConverse/**"
  - "src/providers/shims/clientToolSearch/**"
  - "src/tools/ApplyPatchTool/freeformGrammar.ts"
---

**Decision:** port all four LLM wires found missing against `../opencode` @ `449c128a5b`, automatic
only where a recording proves the wire (user, 2026-11-28). Plan: `.claudin/plans/adaptive-snuggling-castle.md`.

- **One table picks the wire of an `openai_compat` request** (`compatWires.ts`): chat unless a row names
  the host and model. `verified: false` rows run only with `CLAUDIN_OPENAI_RESPONSES=all` /
  `CLAUDIN_VENDOR_ANTHROPIC_WIRE=all`; `=0` turns a family off. A 400/404/422 on the first request of
  a host+model (not an overflow, not a refused replay) falls back to chat for the process
  (`wireFallback.ts`).
- **Responses API** (`openai_responses` request transport, the profile stays `openai_compat`):
  api.openai.com and Azure `/openai/v1` on GPT-5+ (recorded); xAI grok-4+ unverified. Reuses
  `performCodexRequest` without the Codex URL rewrite, headers or `codexBackendBodyFields`; reasoning
  and calls replay under their ids, messages without them, as the recordings do. Everything Codex- or
  Copilot-only still keys on `codex_responses`.
- **Vendor /anthropic** (`vendorAnthropic/client.ts`): verified only for the recorded models —
  MiniMax-M3, kimi-k3, qwen3.7/3.8 on DashScope intl; every other model of those hosts, Z.ai,
  DeepSeek, CN hosts and coding plans are unverified rows. Kimi Code OAuth stays on chat (no OAuth
  hook in the native client). The profile keeps its base URL and tag, so first-party gates stay off;
  the client cuts `metadata`, every beta but interleaved thinking, keep-alive and count_tokens.
- **Bedrock Converse** (`bedrockConverse/`): every vendor-prefixed Bedrock id but Claude (a bare alias
  such as `sonnet` and an ARN stay on the Claude client). Same region as the Claude lane
  (`extras.awsRegion`), HTTP/1.1, the aggressive cache profile (no `cachePoint` is written). Limits are
  a conservative table (Llama 3 output 2048: Bedrock caps it). Reasoning is not requested; returned
  reasoning becomes thinking, never replayed.
- **Freeform Patch** behind `CLAUDIN_FREEFORM_PATCH=1`, off: the Codex CLI 0.172 grammar, gpt-5.5+ on
  the Codex backend and the Responses API, not Copilot. Live probe 2026-11-28 on gpt-6-luna: the backend
  took the custom tool, the call applied, 2 requests = 1 point of a free plan's 30-day window. The A/B
  that would flip it did not fit the agreed 25% budget (free plan at 31%) and waits for the user.
- **Tool search gateway runs ahead of every wire** (`applyClientToolSearch` + `withClientToolSearch` in
  the client factory). It fixed Codex, Copilot GPT-5 and Gemini sending every deferred tool whole and a
  ToolSearch result reaching them empty. On Responses the gateway tool goes non-strict.
- **Fixed on the way:** the compiled binary's Bedrock never worked (`new AnthropicBedrock2` not a
  constructor) — the AWS runtime and credential chain were `external` in `--compile`;
  `smoke:binary` now runs a Bedrock lane. Patch accepts a pure rename (`Move to`, no hunks).

**Why:** Chat Completions drops GPT-5's reasoning between turns and the vendors' native caching and
thinking; non-Claude Bedrock models had no wire at all. Automatic only with a recording, because the
only live account was a free Codex plan.

**What changes for a teammate:** a new `openai_compat` wire is a row in `compatWires.ts`, not a branch
in `resolveProviderRequest`; a new client the factory builds for a wire without server-side tool
search must be covered by `clientDefersTools`; a facade client builds its promise and member view
through `shims/clientFacade.ts` and its fallback through `withWireFallback`. A deferred tool called
through `CallTool` keeps its arguments on Codex (`isClientGatewayTool`): the gateway is non-strict.

**Known gaps, on purpose:** a Converse exception frame mid-stream arrives from the SDK as a bare
`{message}`, so it retries as a 500 whatever its type; a Bedrock profile's small fast model is still a
Claude Haiku id; Converse models have no cost rows. Deviations from the plan, accepted at the review
round of 2026-11-28: no per-row vendor thinking caps, no `modelSupportOverrides` lookup and no
`openaiContextWindows` rows (the vendor's thinking default and the 128k fallback apply, as on chat);
no `reasoning.summary` on Responses (the stream reader drops summary events); no Converse `cachePoint`;
`cache-probe` still probes chat for a Responses session; the chat e2e wraps the shim by hand.

**Rejected:** reusing `codex_responses` for the Responses API (nine consumers key on it, from the
Codex OAuth branch to the URL rewrite); `anthropic` profiles with a vendor base URL (the SDK ignores the
profile's `baseUrl`, and the tag would turn every first-party gate on); Bedrock Mantle (bearer keys only).

**Evidence:** the cassettes under `src/providers/__fixtures__/cassettes/` (opencode's recordings, MIT),
one break-probe spec per area under `scripts/migrations/probes/`, `smoke:binary` on the compiled
binary, and the live freeform probe above. The 3-agent review of 2026-11-28 found 5 bugs with repros
(binary pure rename, Converse region and Esc, replay on the profile model, concurrent fallback) and 4
regressions (Codex strip via CallTool, Converse on RETAIN, Bedrock aliases, routing wider than the
recordings); each now has a red-first test and a probe.
