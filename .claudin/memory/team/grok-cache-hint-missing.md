---
name: grok-cache-hint-missing
description: xAI's prompt-cache key is the x-grok-conv-id HEADER, not a body field, so our openai_compat lane sends Grok no cache hint at all — unmeasured
type: project
---

Researched 2026-08-20, written up at `docs/tech/cache/native-prompt-caching-by-provider.md`.

xAI/Grok, OpenAI and Codex are all **implicit prefix caches** (no Anthropic-style
`cache_control`), but xAI differs on two axes that break an OpenAI-shaped client:

1. **The routing key is an HTTP header** — `x-grok-conv-id` on Chat Completions.
   `prompt_cache_key` in the body only works on xAI's *Responses* endpoint. We send
   `prompt_cache_key` gated on `isOfficialOpenAIUrl` (host `api.openai.com`,
   `src/providers/shims/openaiShim/messagesClient.ts:99`), so Grok — which rides the
   generic `openai_compat` transport — gets **nothing**. Zero `x-grok-conv-id` in `src/`.
2. **Invalidation is per whole message**, not per 128-token block. Our
   `pruneOldToolResults` rewrite of an old `tool_result` discards every message from
   there on, where OpenAI would only lose the suffix.

Grok is nonetheless priced for cache reads (`src/providers/usage/modelCost.ts:174`) and
sits on `AGGRESSIVE_PROFILE` (`src/agent/cache/cacheProfile.ts:151`).

**Why:** "Grok never hits cache" is a well-supported hypothesis, not a measured finding —
no xAI cache test, doc or code path has ever existed in this repo.

**How to apply:** measure with `src/commands/cache-probe/` (with and without the header)
before changing the gate or the clip profile. Also treat the 2026-06-10 OpenAI notes in
`clip-frontier-breakpoint.md` as partly stale — cache writes now bill 1.25× on GPT-5.6+
and `prompt_cache_retention` is superseded by `prompt_cache_options.ttl`, which may make
our `'24h'` a no-op. Related: [[codex-oauth-prompt-cache-params]] — the Codex CLI's own
source confirms it never sends retention either.
