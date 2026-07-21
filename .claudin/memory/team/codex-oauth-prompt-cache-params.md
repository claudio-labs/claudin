---
name: Codex OAuth prompt-cache — retention REJECTED, key only
description: 2026-07-21 — Codex backend 400s on prompt_cache_retention; codexShim + cache-probe now send prompt_cache_key ONLY (retention removed). Official-OpenAI still sends both.
type: project
---

Branch `feat/codex-prompt-cache-params` (commit 8a9221f, 2026-07-18) added
`prompt_cache_key: getSessionId()` + `prompt_cache_retention: '24h'` to
`codexShim` (and `/cache-probe`'s codex_responses branch), gated by
`isCodexBaseUrl()`. **The retention param was WRONG:** a live Codex OAuth
session hits `400 {"detail":"Unsupported parameter: prompt_cache_retention"}`,
which fails the whole request — every Codex call was broken.

**Fix (2026-07-21):** removed `prompt_cache_retention` from the Codex path in
both `codexShim.ts:~516` and `cache-probe.ts:~238`. The Codex backend now
receives **`prompt_cache_key` only** (the error named retention specifically,
so key passes validation). Test at `codexShim.test.ts` flipped to assert
`prompt_cache_retention` is `undefined`. The `isOfficialOpenAIUrl` path in
`openaiShim/messagesClient.ts` STILL sends both — api.openai.com (Chat
Completions) is a different endpoint and accepts retention; do not touch it
without live evidence.

**Why key still helps:** OpenAI prompt caching is automatic prefix-based, but
the key routes a session to the same cache-aware server (~8.5% hit-rate gain
per the messagesClient comment).

**Follow-ups:**
- Live HIT on the Codex backend still unverified — run `/cache-probe` in a
  Codex OAuth session and expect HIT on the 2nd request.
- Copilot (`api.githubcopilot.com`) still deliberately NOT gated in.
