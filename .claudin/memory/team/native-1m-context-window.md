---
name: Native-1M models need an explicit getContextWindowForModel branch
description: Model-launch gotcha — modelSupports1M returning true does NOT set the runtime context window for a native-1M (no-[1m]-suffix) model
type: project
---

Launching a native-1M Claude model (1M by default, no `[1m]` suffix, like Fable 5 / Sonnet 5) requires adding it to the native branch in `src/services/context/context.ts` `getContextWindowForModel` (next to the `fable-5` check), NOT just to `modelSupports1M`.

**Why:** `has1mContext(model)` only tests for the `[1m]` suffix, so `betas.ts` never pushes the `context-1m` beta header for a native-1M model. In `getContextWindowForModel` the beta-header path (`betas.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)`) therefore never fires, and the model falls through to `MODEL_CONTEXT_WINDOW_DEFAULT` (200k) — so auto-compact triggers at 200k while the /model picker advertises "1M context". This bit Sonnet 5 in review (fixed by adding `sonnet-5` to the `fable-5` branch at context.ts ~line 120).

**How to apply:** On any native-1M launch, add the canonical substring to that branch AND write a `getContextWindowForModel(id) === 1_000_000` regression test with no betas passed. `modelSupports1M(id) === true` is necessary but NOT sufficient — it does not exercise the actual window used for compaction.
