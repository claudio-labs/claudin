---
name: Runtime /models discovery only parses `context_length`
description: openaiModelDiscovery consumes only OpenRouter-style context_length; Groq/vLLM/etc. field names are a mapped, unshipped follow-up
type: project
---

Runtime model discovery (`src/utils/model/openaiModelDiscovery.ts`, startup prefetch for provider tag `openai`) feeds `discoveredContextWindows`, which `getOpenAIContextWindow` consults before the 128k fallback — but the parser only reads the **`context_length`** field (OpenRouter style). The map is in-memory per session (re-prefetched each startup, 5s timeout; a failed `/models` silently reverts that session to the table/128k fallback).

**Why:** On 2026-07-02 a user-run proxy started returning `context_length` and the 1M window resolved with zero client changes — proving the plumbing works; only field-name coverage is missing for other backends.

**How to apply:** If a custom/OpenAI-compat provider still falls back to 128k despite its `/models` returning a window, check the field name. Follow-up mapped but not shipped: parse the union `context_length ?? context_window (Groq) ?? max_context_length (Mistral/LM Studio REST) ?? max_model_len (vLLM) ?? meta.n_ctx_train (llama.cpp) ?? capabilities.limits.max_context_window_tokens (Copilot — has its own catalog already)`. Strict OpenAI, DeepSeek, and Azure return nothing — table/env (`CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS`) stays the fallback. Note the setup-time discovery (`src/utils/providerDiscovery.ts:listOpenAICompatibleModels`) is a separate code path that still discards everything but `id`.
