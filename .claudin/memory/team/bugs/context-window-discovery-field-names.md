---
name: Runtime /models discovery only parses `context_length`
description: FIXED 2026-11-12 (fix/sibling-ports-2026-11) — /models discovery reads context_length, context_window, max_context_length, max_model_len and meta.n_ctx_train; the setup-time path still keeps only ids
type: project
paths:
  - "src/providers/model/openaiModelDiscovery.ts"
  - "src/providers/presets/providerDiscovery.ts"
---

**FIXED 2026-11-12** on `fix/sibling-ports-2026-11` (`contextWindowOf` in `openaiModelDiscovery.ts`, pinned in `openaiModelDiscovery.test.ts`). `context_length` still wins when present. The setup-time `listOpenAICompatibleModels` path below is unchanged. What follows is the original note.

Runtime model discovery (`src/providers/model/openaiModelDiscovery.ts`, startup prefetch for provider tag `openai`) feeds `discoveredContextWindows`, which `getOpenAIContextWindow` consults before the 128k fallback — but the parser only reads the **`context_length`** field (OpenRouter style). The map is in-memory per session (re-prefetched each startup, 5s timeout; a failed `/models` silently reverts that session to the table/128k fallback).

**Why:** On 2026-07-02 a user-run proxy started returning `context_length` and the 1M window resolved with zero client changes — proving the plumbing works; only field-name coverage is missing for other backends.

**How to apply:** If a custom/OpenAI-compat provider still falls back to 128k despite its `/models` returning a window, check the field name. Follow-up mapped but not shipped: parse the union `context_length ?? context_window (Groq) ?? max_context_length (Mistral/LM Studio REST) ?? max_model_len (vLLM) ?? meta.n_ctx_train (llama.cpp) ?? capabilities.limits.max_context_window_tokens (Copilot — has its own catalog already)`. Strict OpenAI, DeepSeek, and Azure return nothing — table/env (`CLAUDIN_OPENAI_CONTEXT_WINDOWS`) stays the fallback. Note the setup-time discovery (`src/providers/presets/providerDiscovery.ts:listOpenAICompatibleModels`) is a separate code path that still discards everything but `id`.
