---
name: reasoning-catalog-regen-drops-opencode-endpoints
description: A full `bun run codegen:reasoning-catalog` since 2026-11-24 drops the opencode.ai zen/v1 and zen/go/v1 endpoint rows (models.dev moved them to /inference/...) and turns 15 effort tests red; new models are added row by row until that is resolved
type: project
paths:
  - "src/providers/model/reasoningCatalogData.ts"
  - "scripts/codegen/reasoning-catalog.ts"
---

On 2026-11-24 (branch `feat/glm-5-4`) a full regen of `reasoningCatalogData.ts` changed 263+/104− lines.
Most of it was ordinary models.dev churn. One part breaks us: the `opencode` and `opencode-go` endpoints
moved from `opencode.ai/zen/v1` and `zen/go/v1` to `opencode.ai/inference/openai/v1` and
`inference/go/openai/v1`. The presets in `providerProfiles.ts` (`opencode-zen`, `opencode-go`) still use
the `zen/` URLs, so those profiles stop resolving a catalog row and lose every effort level. That turned
15 tests red in `reasoningCatalog.test.ts`, `reasoningEffortInvariant.test.ts` and the shim suites.

**Why:** the regen was held back so the GLM-5.4 change would not also change effort behavior for OpenCode.
The `glm-5.4` rows (zai-coding-plan and zhipuai-coding-plan, `low/high/max`) were added by hand,
byte-identical to what the generator emits, so the next full regen leaves them unchanged.

**How to apply:** before the next full regen, check whether OpenCode still serves `zen/` and whether the
presets should move to `/inference/`. Either repoint the presets or keep the old rows as extra endpoints.
Until then, add a new model as its generator-identical row and say so in the commit. Related:
[[opencode-gateway-effort-dead-on-arrival]].
