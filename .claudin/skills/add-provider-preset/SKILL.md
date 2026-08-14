---
name: add-provider-preset
description: Add a new /provider preset to Claudin — the OpenAI-compatible API-key recipe (4-6 files) or the OAuth web-login variant (~16 files). Use when the user asks to add support for a new model provider / vendor.
argument-hint: "<provider name> [oauth]"
---

# /add-provider-preset — add a Claudin `/provider` preset

Two paths depending on auth. Confirm which the vendor uses first (API key/token
→ path A; browser sign-in / device code → path B).

## Path A — OpenAI-compatible, API-key preset (4-6 files)

The common case. `provider: 'openai'`, `requiresApiKey: true`. Recurring touch-set
(zai 980aabd7, cloudflare c6b2d20a, opencode-zen 4a4e619):

1. **`src/services/api/providerProfiles.ts`** — add the key to the `ProviderPreset` union
   AND a `getProviderPresetDefaults` switch case. ⚠️ The switch `default` falls
   through to `ollama`, so a union member with **no case silently becomes Ollama**
   (no compile error). This fn reads NO env — defaults are deterministic.
2. **`src/components/ProviderManager.tsx`** — add a `{ value, label, description }`
   menu entry; the value flows straight into `getProviderPresetDefaults(preset)`,
   no extra wiring.
3. **`src/services/api/providerProfiles.test.ts`** — mirror the `opencode-zen` defaults test.
4. **`src/components/ProviderManager.test.tsx`** — add the preset to **`PRESET_ORDER`**.
   ⚠️ This is a TEST-ONLY ordering registry (not a source constant), so the menu
   wiring is NOT self-contained — omit it and the ProviderManager test fails.
5. **`src/services/api/openaiShim/constants.ts`** — ONLY if the vendor serves a GLM
   (Zhipu) or DeepSeek family model: add its host to `GLM_API_HOSTS` /
   `DEEPSEEK_API_HOSTS` (~line 22/30), or that family's tool-calling/format addendum
   silently won't apply. Then add a case to
   `src/services/api/openaiShim/__tests__/regression.test.ts` (opencode-zen 4a4e619).
6. **`src/components/StartupScreen.ts`** — ONLY if the default model name collides
   with a vendor regex in the pill name-detection (see gotcha below).

**Base URL is passed verbatim:** `resolveProviderRequest` + `asEnvUrl` only trim a
trailing slash; the chat path is `${baseUrl}/chat/completions` with **NO `/v1`
injection** (`normalizePathWithV1` is for local-Ollama retries only). So URLs ending
in `/v4` (Z.AI) or `/compat` (CF gateway) work. For account-scoped URLs, ship a
`YOUR-ACCOUNT-ID` placeholder (like `azure-openai`/`foundry`). A second auth header
(e.g. CF gateway `cf-aig-authorization`) rides `extras.customHeaders`.

**Pill-mislabel gotcha:** `StartupScreen` name-detection tests the MODEL string as a
fallback after the base-URL checks. A default model containing "llama"
(`@cf/meta/llama-3.3-…`) hits `else if (/llama/i.test(rawModel)) name = 'Meta Llama'`
and mislabels the pill. Fix: add a base-URL guard (e.g. `/cloudflare/i`) in the
base-URL block BEFORE the model fallbacks, ordering more-specific hosts first
(`gateway.ai.cloudflare` before generic `cloudflare`).

Reference commits: `feat(zai)` 980aabd7, `feat(cloudflare)` c6b2d20a.

## Path B — OAuth / web-login preset (~16 files; xAI is the template)

Much bigger than a menu clone. The canonical template is **xAI** (9425ad9, b7a781e —
loopback PKCE); **copilot** (dc28c35) is the GitHub-style **device-code** variant.
Decide loopback PKCE vs device-code (RFC 8628) up front — xAI switched once (479e78f).
Reuse — do NOT re-port — the token store / PKCE / callback server in
`src/services/oauth/` + `src/utils/browser.ts`. Device-code providers reuse
`src/commands/provider/GithubDeviceFlowStep.tsx` + `src/services/github/deviceFlow.ts`.
(The declarative `Method`/`Authorization`/`prompts` two-step from opencode's
`provider/auth.ts` was explicitly deferred — don't build it unless asked.)

Recurring touch-set (rename `<vendor>` per provider):
- **Flow:** `src/services/api/<vendor>OAuth.ts` (+`.test.ts`) and a
  `<vendor>OAuthShared.ts` for shared consts.
- **Credentials:** `src/utils/<vendor>Credentials.ts` (+`.test.ts`) AND register the
  key in `src/services/secureStorage/index.ts`. UA header in `src/utils/<vendor>UserAgent.ts`.
- **Wire:** inject the auth header in `src/services/api/openaiShim/messagesClient.ts`;
  handle 401/refresh in `src/services/api/withRetry.ts`.
- **Schema:** `src/services/api/providerConfig.ts` (+`providerConfig.test.ts`) — profile
  + credential schema.
- **UI:** `src/components/use<Vendor>OAuthFlow.ts` (+`.test.tsx`) and the
  `<XxxOAuthSetup>` clone in `ProviderManager.tsx`; `src/commands/provider/doctor.tsx`
  (doctor check); `src/services/config/config.ts`; `README.md`.
- **Models (if the provider exposes a catalog):** a catalog like
  `src/utils/model/copilotModelCatalog.ts` (dc28c35) + context-window entries in
  `src/utils/model/openaiContextWindows.ts` / `model.ts` / `providers.ts`. Dynamic
  discovery lives in `src/services/api/providerDiscovery.ts`.

Backlog of OAuth providers opencode ships that Claudin lacks (re-verify against the
sibling repo `../opencode/packages/opencode/src/plugin/` — this
list decays): **GitLab Duo** (npm `opencode-gitlab-auth`, enterprise), **DigitalOcean**
(`plugin/digitalocean.ts`, small), **Azure OAuth** (`plugin/azure.ts`, upgrades the
current API-key Azure preset), **Poe** (npm `opencode-poe-auth`, aggregator, lower
priority). Already shipped: Anthropic, Codex/ChatGPT, Copilot device-flow, xAI, Z.AI,
Cloudflare (API-key). Devin is blocked (see `docs/tech/devin-provider/`).

## Finish

Run `/pre-pr` (build → smoke → typecheck → focused test), then
`bun run test:provider` since this touches `src/services/api/*`/provider config. Name
the provider you exercised in the PR description.
