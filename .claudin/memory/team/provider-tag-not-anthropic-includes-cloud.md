---
name: A provider !== 'anthropic' check wrongly includes bedrock/vertex/foundry
description: sanitizeProvider collapses most OpenAI-compat tags to 'openai' but cloud SDK providers keep their own non-anthropic tags; gate OpenAI-only behavior with an exclusion set, not != 'anthropic'
type: project
---

`ProviderProfile['provider']` (src/utils/providerProfiles.ts) is a wide union,
but `sanitizeProvider()` collapses it: only `anthropic`, `mistral`, `gemini`,
`bedrock`, `vertex`, `foundry` survive as-is — every other OpenAI-compat preset
(deepseek, groq, openrouter, lmstudio, together, custom, …) is stored as
`'openai'`.

**Why:** `bedrock`/`vertex`/`foundry` run Claude via cloud SDKs and have NO
OpenAI-style `/models` HTTP endpoint. They also reach the `ProviderManager`
manual form (via the `cloud-extras` screen) with `draftProvider` set to their
own tag — which is NOT `'anthropic'`.

**How to apply:** to gate "OpenAI-compatible over HTTP" behavior in the provider
form (e.g. `/models` discovery), do NOT use `draftProvider !== 'anthropic'` — it
wrongly pulls in the three cloud providers. Use an explicit exclusion set:
`MODEL_DISCOVERY_EXCLUDED_PROVIDERS = {anthropic, bedrock, vertex, foundry}`
(see ProviderManager.tsx). The bug was caught by the Bedrock/Foundry preset
tests timing out (they got routed to the OpenAI model-discovery screen).
