---
name: Recipe for adding an OpenAI-compatible /provider preset
description: SUPERSEDED by the /add-provider-preset skill — kept for the StartupScreen pill mislabel gotcha and the base-URL passthrough rules, which the skill does not spell out
type: feedback
---

> **The canonical recipe is the `/add-provider-preset` skill**
> (`.claudin/skills/add-provider-preset/SKILL.md`), which covers both the
> API-key and the OAuth variants. Use it. What is kept here is the pill
> mislabel gotcha and the base-URL passthrough rules below, which the skill
> does not state. Paths refreshed 2026-09-21 after the 2026-08 reorg.

Adding an API-key, OpenAI-compatible provider preset (no OAuth) touches 3-4 files.

**How to apply:**
1. `src/providers/presets/providerProfiles.ts` — add the key to the `ProviderPreset` union AND a `getProviderPresetDefaults` switch case. The switch `default` falls through to `ollama`, so a union member WITHOUT a case silently becomes Ollama (no compile error). Such presets use `provider: 'openai'`, `requiresApiKey: true`. This fn reads NO env — defaults are deterministic (the `delete process.env.OPENAI_MODEL` in existing tests is vestigial).
2. `src/providers/ui/screens/PresetSelection.tsx` (the preset list left `ProviderManager.tsx` in the 2026-09-19 split) — add a `{ value, label, description }` menu entry; the value flows straight into `getProviderPresetDefaults(preset)`, no extra wiring. Add it to `PRESET_ORDER` in `ProviderManager.test.tsx` too, or every navigation test after the insertion point times out ([[providermanager-tui-tests-fail-non-tty]]).
3. `src/providers/presets/providerProfiles.test.ts` — mirror the `opencode-zen` defaults test.
4. `src/platform/StartupScreen.ts` — ONLY if the default model name collides with a vendor regex in the pill name-detection.

**Why (the gotcha):** StartupScreen name-detection tests the MODEL string as a fallback after the base-URL checks. A default model containing e.g. "llama" (`@cf/meta/llama-3.3-...`) hits `else if (/llama/i.test(rawModel)) name = 'Meta Llama'` and mislabels the provider pill. Fix: add a base-URL guard (e.g. `/cloudflare/i`) in the base-URL block BEFORE the model fallbacks, ordering more-specific hosts first (`gateway.ai.cloudflare` before generic `cloudflare`).

Base URL is passed verbatim: `resolveProviderRequest` + `asEnvUrl` only trim/strip the trailing slash; the chat path is `${baseUrl}/chat/completions` with NO `/v1` injection (the `normalizePathWithV1` helper is for local-Ollama retries only). So endpoints ending in `/v4` (Z.AI) or `/compat` (CF gateway) work. For account-scoped URLs, ship `YOUR-ACCOUNT-ID` placeholders like `azure-openai`/`foundry`. A 2nd auth header (e.g. CF gateway `cf-aig-authorization`) rides `extras.customHeaders`.

Reference commits: `feat(zai)` 980aabd7, `feat(cloudflare)` c6b2d20a (both on main, 2026-06-21).
