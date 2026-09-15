---
name: growthbook-source-dead-stub-is-real
description: src/platform/analytics/growthbook.ts (986 lines) never runs — the build replaces the whole module with a ~200-line stub, so source and bundle resolve flags by different rules and bun test exercises the dead one
type: project
---

Measured 2026-09-15. `scripts/build/no-telemetry-plugin.ts:44` registers a stub
for the key `src/platform/analytics/growthbook`, and that stub **replaces the
entire module** in the bundle. So there are two implementations of feature-flag
resolution and only one of them ships:

| | source (986 lines) | build stub (~200 lines) |
|---|---|---|
| runs in `dist/` | never | always |
| runs under `bun test` | **yes** | never |
| resolution order | GrowthBook client → `defaultValue` | `~/.claudin/feature-flags.json` > `_openBuildDefaults` > `defaultValue` |

Under `bun test` the real file runs against `src/stubs/growthbook-stub.ts` (a
13-line no-op class aliased in `bunfig.toml`), so every gate returns its
call-site `defaultValue` — which is **not** what the binary does for the five
keys in `_openBuildDefaults` (`tengu_passport_quail`, `tengu_coral_fern`,
`tengu_bramble_lintel`, `tengu_glacier_2xr`, `tengu_sedge_lantern`). A test
cannot observe the shipped resolution today.

The live semantics are therefore documented **only** inside a template string,
and `no-telemetry-growthbook-stub.test.ts` tests them by regex-scraping that
string out of the plugin source.

**Collapsing the two into one real module is planned** ([[dead-code-cleanup-2026-09-15]],
Fase 4b) and is guarded by `scripts/build/__tests__/flagResolution.characterization.test.ts`
— a table of what all 91 `tengu_*` gate keys resolve to in a stock install, with
the four `_openBuildDefaults` assertions as the control that the override path
was actually exercised.

Do **not** delete `growthbook.ts` outright: the gate readers
(`getFeatureValue_CACHED_MAY_BE_STALE`, `checkStatsigFeatureGate_CACHED_MAY_BE_STALE`,
`checkGate_CACHED_OR_BLOCKING`, `getDynamicConfig_CACHED_MAY_BE_STALE`) are the
live mechanism behind `~/.claudin/feature-flags.json` — a user-facing contract.
Only the GrowthBook client half is dead.

Related: [[ink-modules-unimportable-in-tests]] (the same missing package is why
`.tsx` cannot be imported in tests — note that memory still cites pre-reorg
paths).
