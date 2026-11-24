---
name: codex-model-list-per-account
description: Since 2026-11-24 the Codex backend's model list, windows, effort levels and default effort come from the account's own GET /backend-api/codex/models, with Codex CLI 0.172's bundled catalog as the fallback snapshot; gpt-6.x rows and the GPT-5+ effort fallback for the other providers
type: project
scope: providers/model/codexModelCatalog
impact: functional
---

**Decision:** on the ChatGPT Codex backend, the account's own catalog answers everything:
- **What answers.** `codexModelRefresh.ts` asks `GET /backend-api/codex/models?client_version=0.172.0` at startup, after a Codex login, and on a profile switch. The answer goes to `setCodexAccountModels` in `codexModelCatalog.ts`, and while that list is set it is the only answer for the account. The picker shows `visibility: list` models in priority order. Each model carries its `context_window`, its levels from low to max (`ultra` is dropped), and its `default_reasoning_level`.
- **The fallback.** The snapshot in `codexModelCatalog.ts` copies the catalog bundled in Codex CLI 0.172.0, 11 models. It answers until the fetch lands, offline, and when the fetch fails.
- **Default effort.** `getDefaultEffortForModel` returns the account default ahead of the alias table and of the ultrathink `medium`. The effect, with no pin: gpt-6.2-sol, gpt-6.1-* and gpt-5.6-sol go out at `low`, gpt-6-luna and gpt-5.6-terra at `medium`. `/effort` opens on that same level.
- **The other providers.**
  - The reasoning catalog gained 36 rows, hand-added but line for line what the generator emits, for gpt-6.x on openai, azure, cloudflare-ai-gateway, opencode, opencode-go and openrouter.
  - The effort fallback for an endpoint with no row now covers GPT-5 and every later major, so Copilot and proxies get `low…xhigh`.
  - The gpt-6.x API windows are 1.05M in / 128k out.
- **Killswitch:** `CLAUDIN_CODEX_MODELS_FETCH=0`. `src/stubs/test-preload.ts` sets it, so no suite reaches chatgpt.com with the machine's credentials.

**Why:** the list depends on the plan. On 2026-11-24 a free account's `~/.codex/models_cache.json` listed gpt-6-luna, gpt-5.6-terra and gpt-5.6-luna. Codex CLI 0.172's bundled catalog lists gpt-6.2-sol and gpt-6.2-astra for paid plans only (`available_in_plans`, `minimal_client_version 0.166.0`). A static list is wrong for some account either way. Before this, gpt-6.x had no effort and the 128k fallback on every provider.

**What changes for a teammate:**
- **A pin still wins.** Without one, the built binary used to send `medium` for every Codex model. The cause was the ultrathink fallback in `getDefaultEffortForModel` (`feature('ULTRATHINK')` is on in the build and off under `bun test`), not the alias `high`. Only the models whose account default is `low` change.
- **Copilot.** Its live catalog now wins over the bare table in `getOpenAIContextWindow` and `getOpenAIMaxOutputTokens`. A bare id there carries the OpenAI API's window, so gpt-5.6-* on Copilot used to be sized at 1.05M.
- **`/effort`.** It kept relabelling xhigh as max on models that also take a real max. Every account model showed `low medium high max max`, and a saved max opened on xhigh. Fixed.
- **Removed.** `filterCodexModels` and the opencode `gpt-X.Y > 5.4` rule are gone; neither ever decided anything for a catalog id.
- **`codexplan` stays `gpt-6-luna`**, because every plan that has Codex offers it. The Codex CLI's "follow the account's first model" was offered and not taken.

**Rejected:**
- **Static list only (the 0.172 snapshot for everyone).** A free plan would list gpt-6.2-* and get 400 "not supported when using Codex with a ChatGPT account".
- **Refreshing the list on every `/model` open.** That is not Copilot parity, and it touched `model.tsx`, which has 13% coverage.
- **Defaults only for models without an alias default.** That leaves two default sources on the backend.
- **Prices for gpt-6.x in `modelCost.ts`.** Out of scope.

**Evidence:**
- `scripts/migrations/probes/codexModelRefresh.json`: 30 probes red, 2 controls green.
- Codex CLI 0.172's bundled catalog, read from the binary (`"slug": "gpt-6.2-sol"` …).
- Wire context: [[codex-0.162-wire-diff]].
