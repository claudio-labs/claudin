---
name: gemini-native-transport
description: Since 2026-10-28 (branch feat/gemini-native) Gemini profiles on Google's own hosts talk native generateContent like gemini-cli (API key, ADC, Vertex), with thoughts shown and thought tokens billed; /provider has one Google row; /model on Gemini lists Google's own models; Code Assist / Login with Google REJECTED (ToS); killswitch CLAUDIN_GEMINI_NATIVE=0
type: project
scope: src/providers/shims/gemini, providers/presets, providers/model, providers/ui
impact: functional
paths:
  - "src/providers/shims/gemini/**"
  - "src/providers/model/configs.ts"
  - "src/providers/model/modelOptions.ts"
---

**Decision:** a `gemini` profile whose base URL is Google's — the Gemini API off
`/openai`, or a Vertex `aiplatform` host — goes through `src/providers/shims/gemini/`
(`streamGenerateContent?alt=sse`), modeled on what gemini-cli sends. A URL ending in
`/openai`, or any proxy (LiteLLM, a gateway), stays on the OpenAI-compatible shim.
`CLAUDIN_GEMINI_NATIVE=0` sends every Gemini profile to compat; a profile already
moved to `/v1beta` is then sent to `/v1beta/openai` (`geminiCompatBaseUrl`). Profiles
holding the exact old default URL are moved once at startup; any other URL is left alone.
- **Auth:** API key as `x-goog-api-key`; gcloud ADC as Bearer plus `x-goog-user-project`;
  Vertex from `extras.gcpProject` / `extras.gcpRegion` with ADC.
- **Thinking:** `includeThoughts` on, thoughts become thinking blocks, `thoughtsTokenCount`
  is billed as output. With no effort set: Gemini 3+ `high`, 2.5 `medium`; /effort maps to
  `thinkingLevel` (3+) or a budget (2.5). A model newer than the reasoning catalog gets
  low/medium/high.
- **/provider:** one "Google" row opens API key / gcloud / Vertex·Gemini / Vertex·Claude,
  like the Anthropic row (the user asked for it from a screenshot: two Google rows were
  confusing).
- **/model:** on a native Gemini profile it lists the profile's models plus Google's
  `GET /models` (refreshed at startup and on /model, cached per profile, limits recorded
  as context windows). Claude tiers map to `GEMINI_FLAGSHIP_MODEL` / `GEMINI_FLASH_MODEL`
  / `GEMINI_FLASH_LITE_MODEL` in `configs.ts` (`gemini-4-argon`, `gemini-3.8-flash`,
  `gemini-3.1-flash-lite`); Gemini 2.0 is shut down and must not come back as a fallback.
  Gemini ≥2.5 not in the table gets 1M in / 65k out (`geminiFamilyLimits`).

**Why:** the compat endpoint asked for no thoughts and showed none, and three bugs lived
on that path (below). gemini-cli was analysed at `718e97c24` (2026-10-28).

**Fixed on the way (red test first, break-probe `geminiBugFixes.json` 12/12,
`geminiModelFixes.json` 13/13):**
- With tool search at `standard` — the default for every non-Anthropic provider —
  `normalizeMessagesForAPI` rebuilt `tool_use` without its `signature`, so every Gemini
  tool call lost its thought signature; the other branch leaked a Gemini signature to
  Anthropic. One helper now decides: `geminiStateToKeep` (`shims/gemini/blockState.ts`).
- The compat converter overwrote a real `extra_content.google.thought_signature` with
  `skip_thought_signature_validator`.
- Gemini 3.x priced as 2.0 Flash; the preset default `gemini-3-flash-preview` sized at the
  128k fallback (compaction ~8× early); the /model tiers pointed at shut-down 2.0 models.
- A reply that only thought and ended `end_turn` was accepted silently on EVERY provider;
  now it falls back like an empty stream (`classifyStreamEnd`), except after a
  `StructuredOutput` call. Killswitch `CLAUDIN_THINKING_ONLY_RETRY=0`.

**What changes for a teammate:** prices in `modelCost.ts` carry dates —
`gemini-4-argon` doubles on 2026-12-01, 3.6/3.8 Flash on 2027-01-01 — and the rows switch
by themselves; re-check Google's pricing page when touching them. A provider change on
this path needs `src/providers/shims/gemini/providerNeutrality.invariant.test.ts` green:
it pins what the compat and other transports still receive.

**Rejected:** Code Assist (`cloudcode-pa`, Login with Google). gemini-cli's own
`docs/resources/tos-privacy.md:10-14` calls third-party use of its OAuth a violation that
can suspend the account. Also not taken: Pro→Flash fallback on 429 and the per-turn
classifier router (an extra call each turn).

**Not validated live:** no Gemini key or GCP project was available; the native wire,
Vertex and the model list are verified against mocks and recorded shapes only. The live
smoke (multi-turn tool calls, visible thoughts, cache read) is still owed. The cache
profile is a separate open item: [[gemini-cache-profile-aggressive]].
