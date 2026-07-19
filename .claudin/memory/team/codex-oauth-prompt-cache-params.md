---
name: Codex OAuth prompt-cache params shipped
description: 2026-07-18 — codexShim now sends prompt_cache_key + 24h retention gated by isCodexBaseUrl; Copilot gate deferred pending /cache-probe evidence
type: project
---

Branch `feat/codex-prompt-cache-params` (commit 8a9221f, 2026-07-18) closed a
gap: `codexShim.performCodexRequest` now sends `prompt_cache_key:
getSessionId()` + `prompt_cache_retention: '24h'` to the chatgpt.com Codex
backend, gated by `isCodexBaseUrl()` (custom/proxied baseUrls never receive
them — unknown body fields can 400). `/cache-probe` already sent both on
codex_responses; production shim was missing them. messagesClient already had
the equivalent `isOfficialOpenAIUrl` gate for api.openai.com — that change
only added its first tests.

**Why:** OpenAI prompt caching is automatic prefix-based, but the key routes a
session to the same cache-aware server (~8.5% hit-rate gain per the
messagesClient comment) and retention extends TTL to 24h.

**How to apply / follow-ups:**
- Unverified against a live Codex OAuth session — run `/cache-probe` in one
  and expect HIT on the 2nd request before claiming the benefit.
- Copilot (`api.githubcopilot.com`) was deliberately NOT gated in — decided to
  wait for empirical `/cache-probe` evidence in a Copilot session first.
- OpenAI cache extensions beyond this live per-transport: openaiShim
  (chat-completions), codexShim (responses), policy in `src/services/cache/`.
