---
name: grok-cache-hint-missing
description: xAI's prompt-cache key is the x-grok-conv-id HEADER; we now send it (2026-09-11) but the cache effect is still UNMEASURED — no xAI account
type: project
---

Researched 2026-08-20, re-verified against docs.x.ai and **partly shipped**
2026-09-11 on `feat/xai-conv-id`. Write-up: `docs/tech/cache/native-prompt-caching-by-provider.md`.

xAI/Grok, OpenAI and Codex are all **implicit prefix caches** (no Anthropic-style
`cache_control`), but xAI differs on two axes that break an OpenAI-shaped client:

1. **The routing key is an HTTP header** — `x-grok-conv-id` on Chat Completions.
   `prompt_cache_key` in the body is documented for xAI's *Responses* endpoint
   only, and Chat Completions' tolerance of unknown body fields is undocumented.
   **Now sent** (`getSessionId()`, gated on the exact host `api.x.ai` via
   `isXaiOAuthBaseUrl`, killswitch `CLAUDIN_DISABLE_XAI_CONV_ID=1`) in the shared
   header object of `_doOpenAIRequest`. Body untouched.
2. **Invalidation is per whole message**, not per 128-token block — confirmed in
   their docs: the prefix is "how many messages at the beginning match a previous
   request exactly". Our `pruneOldToolResults` rewrite of an old `tool_result`
   discards every message from there on, where OpenAI would only lose the suffix.
   **Not addressed**, and it may dominate the header.

Grok is priced for cache reads (`src/providers/usage/modelCost.ts:174`) and still
sits on `AGGRESSIVE_PROFILE` (`src/agent/cache/cacheProfile.ts:189`, fallthrough).

**Why:** the header shipped on xAI's documentation, not on evidence — there was no
xAI account or credits to measure with. Two corrections to the 2026-08-20 round
came out of the re-read: the header is **optional** (caching is automatic on
prefix match; the header only makes routing sticky, so the expected effect is a
hit-*rate* gain, not caching on/off), and xAI never states "constantly-zero
`cached_tokens`" as the symptom of omitting it — that was an overstatement.

**How to apply:** `/cache-probe` now carries the instrumentation — a `--conv-id`
flag and OAuth-session auth via `resolveOAuthProviderAuth`. Three runs answer it:
`--no-key` (baseline), `--no-key --conv-id` (header only, the shipped config),
`--conv-id` (header + body key, which also tests xAI's body-field strictness);
read `prompt_tokens_details.cached_tokens` off call 2. Do **not** move Grok off
`AGGRESSIVE_PROFILE` before that — retain holds whole tool results in context and
costs real money if the cache still misses. Also open, and deliberately excluded
as another provider's problem: OpenAI's API reference marks
`prompt_cache_retention` deprecated in favour of `prompt_cache_options.ttl`
(GPT-5.6+, only value `30m`), so our `'24h'` at `messagesClient.ts:377,845` may be
dead or a latent 400; cache writes now bill 1.25× on GPT-5.6+. Related:
[[codex-oauth-prompt-cache-params]] — the Codex CLI's own source confirms it never
sends retention either.
