---
name: Shim-only request-body fields must be gated model-aware (github_copilot+Claude routes native)
description: A provider-specific field added to the openaiShim request body 400s native Anthropic and Copilot-on-Claude unless gated on activeTransportUsesOpenAiShim(model)
type: project
---

Any field added to the OpenAI-shim request-body object in `claude/streaming.ts` that only the shim consumes (e.g. `effortValue`) is forwarded verbatim by the **native Anthropic SDK** for the anthropic/bedrock/vertex/foundry transports, which reject unknown fields with `400 "Extra inputs are not permitted"`. Gate such fields on `activeTransportUsesOpenAiShim(resolvedModel)` (in `utils/model/providers.ts`).

**Critical subtlety — the predicate is model-aware, not a plain transport-set check.** `github_copilot` IS in the shim transport set, but a `github_copilot` profile running a **Claude model** routes through the native Anthropic SDK (`isGithubNativeAnthropicMode` in `client.ts`), so the predicate must return false there too. A naive `OPENAI_SHIM_TRANSPORTS.has(transport)` reintroduced this exact 400 (caught in review, 2026-07-18). The predicate lives in `providers.ts` (not `activeProvider.ts`) specifically so it can reuse `isGithubNativeAnthropicMode` without a circular import.

**Why:** the shim-only `effortValue` param was added unconditionally to the wire body and broke every native-Anthropic request once an `/effort` level was set — it bit the branch's own author when switching back to an Anthropic profile.

**How to apply:** before adding any provider-quirk field to the shim body, spread it conditionally behind `activeTransportUsesOpenAiShim(options.model)`; keep the shim transport set in `providers.ts` in sync with the factory in `client.ts`; and remember github_copilot splits by model (Claude→native SDK, others→shim).
