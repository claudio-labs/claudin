---
name: openai-compat-client-tool-search
description: Since 2026-10-31 (branch feat/openai-compat-tool-search) the openai shim's Chat Completions path defers tools on the client — deferred tools leave tools[], a ToolSearch tool_reference becomes the schema as text, one fixed CallTool gateway invokes a loaded tool; Ollama reads /api/show (window, thinking, Modelfile sampling), reports its KV cache, is free, waits 30 min; killswitch CLAUDIN_SHIM_TOOL_SEARCH=0
type: project
scope: src/providers/shims/clientToolSearch, providers/shims/openaiShim, providers/model, providers/cache, providers/ui, agent/tools
impact: functional
paths:
  - "src/providers/shims/clientToolSearch/**"
  - "src/providers/shims/openaiShim/**"
  - "src/providers/model/ollama*.ts"
  - "src/agent/tools/toolSearch.ts"
---

**Decision:** on `openai_compat`, `mistral` and non-Claude `github_copilot` profiles whose
requests go out as Chat Completions (`usesShimChatCompletions`, `clientToolSearch/gate.ts`),
tool search stays on under `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS` and the shim does the
server's half itself:
- a `defer_loading` tool leaves `tools[]` (`planToolDeferral`); a forced `tool_choice` is sent whole;
- a ToolSearch `tool_reference` becomes the tool's schema as `<functions>` text at that point
  of the history (`renderLoadedTools`, stableStringify), and its `Tool loaded.` sibling is dropped
  (it used to land after the tool message and make the coalescer invent an interrupted turn);
- the model calls a loaded tool through `CallTool {name, arguments}`; the stream/non-stream
  parsers rewrite it to a `tool_use` of the real tool, and the history writes it back as a gateway call.
`tools[]` never changes mid-session, so a discovery only appends — Ollama's KV prefix survives.
Gemini (native or compat) and the Responses path (Codex, Copilot GPT-5) still send every tool.
`CLAUDIN_SHIM_TOOL_SEARCH=0` restores the old path.

**Why:** a project with a Portainer MCP (239 tools) sent 305 schemas on every request — 94k of a
112k-token prompt — and Ollama on a 3060 (157 tok/s prefill) took 10+ min for "ola" (2026-10-31).
Measured after, same project, real Ollama: 22.7k tokens, first request 2m30s, the next two 5.5s
each (22705 → 22958 → 23080 tokens through a ToolSearch + call). Alternatives rejected: growing
`tools[]` on discovery (re-prefills the whole prompt on Ollama), name-only stubs (~32k, and
Ollama's Qwen parser types arguments from the schema).

**Fixed in the same branch (red tests first; `scripts/migrations/probes/openaiCompatOllamaFixes.json` 19/19):**
- Esc on the shim path printed `API Error: The operation was aborted.` — the DOMException
  missed the SDK-only check (`isUserAbort`, `shims/claude/userAbort.ts`).
- The shim ignored `API_TIMEOUT_MS`; Bun's 5-min fetch idle timer (and undici's 300 s
  `headersTimeout` under Node) cut a long prefill and retried it ten times. Now `API_TIMEOUT_MS`,
  else 30 min local / 600 s hosted (`openaiShim/fetchTimeout.ts`).
- Footer `in:` was an estimate without tools; Ollama is now asked for usage and its
  `cached_tokens` read as a KV cache (prefill = write, reused prefix = read; `kvCache`),
  `:11434` resolves to `'ollama'` before `'self-hosted'`, the footer uses the Anthropic row for it,
  and other no-cache providers get Nerd Font arrows (`nf-md-arrow_up/down_bold`) instead of `in:/out:`.
- A local endpoint is free (`calculateUSDCost` → 0 on `isLocalProviderUrl`).
- `/api/show` + `/api/ps` (`model/ollamaModelInfo.ts`): context window (262k, not the 128k
  fallback, whose warning now prints once per model), thinking capability (gpt-oss gets
  low/medium/high; Qwen-style on/off gets a "/config → Thinking" note instead of "Effort not
  supported"; thinking off sends `reasoning_effort: "none"`), and the Modelfile's temperature/top_p
  (Ollama's /v1 forces 1.0 over a missing field).
- Auto mode with a local non-Claude model asks instead of classifying
  (`permissions/permissions/localClassifier.ts`): a Qwen 3B-active MoE denied a Portainer call
  citing an unrelated `cat`.

**What changes for a teammate:** a new OpenAI-compatible request path must decide whether it
honors `defer_loading`; if it converts tools itself, either route through `planToolDeferral`
or leave `usesShimChatCompletions` false for it. Not done: the same gateway for Gemini/Codex.
