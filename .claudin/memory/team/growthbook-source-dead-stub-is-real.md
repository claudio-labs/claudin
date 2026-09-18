---
name: growthbook-source-dead-stub-is-real
description: RESOLVED 2026-09-18 — the growthbook build stub is gone and src/platform/analytics/growthbook.ts (214 lines) is now the real, shipped flag reader; the two-implementations trap this memory described no longer exists
type: project
---

**This is closed. Kept because the shape of the trap recurs, and because older
notes still describe the dead half as if it shipped.**

What it used to be (measured 2026-09-15): `scripts/build/no-telemetry-plugin.ts`
registered a stub for the key `src/platform/analytics/growthbook` that replaced
the **entire module** in the bundle. So flag resolution had two
implementations — a 986-line source file that ran only under `bun test`, and a
~200-line stub string that ran only in `dist/` — and they resolved by different
rules. A test could not observe the shipped behaviour at all.

What it is now: the collapse (Fase 4b of [[dead-code-cleanup-2026-09-15]])
happened. `no-telemetry-plugin.ts` is down to **three** stubs from nineteen and
says so in its own header: *"Feature-flag resolution used to be the biggest
entry here … That stub is now the source itself."* `growthbook.ts` is **214
lines**, it is the module that ships, and ~168 files import its gate readers
(`getFeatureValue_CACHED_MAY_BE_STALE`,
`checkStatsigFeatureGate_CACHED_MAY_BE_STALE`, `checkGate_CACHED_OR_BLOCKING`,
`getDynamicConfig_CACHED_MAY_BE_STALE`) — the live mechanism behind
`~/.claudin/feature-flags.json`, a user-facing contract. `src/platform/analytics/`
is that file plus its test, and the slice stays.

The generalisable part: **a build-time stub that replaces a whole module makes
the source file dead while leaving it fully test-covered**, so every gate stays
green over an implementation that never runs. Two of the three surviving stub
keys name a module that no longer exists anywhere, which
`no-telemetry-stubs-resolve.test.ts` reports rather than fails on — and deleting
a stubbed module means deleting its stub key in the same change, because a key
that stops matching does not fail loudly, it just bundles the real module.

Related: [[bash-parser-unreachable-behind-tree-sitter-flag]] is the same class
of finding — a complete, tested implementation that cannot run — reached from
the flag side rather than the stub side.
