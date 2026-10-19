---
name: Node engine floor raised to 22.19.0
description: engines.node is >=22.19.0 since 2026-10-19 for undici 8.12 (zstd at load); was >=22.12.0 for commander 15, >=20 before
type: project
---

`engines.node` is `>=22.19.0` as of 2026-10-19 (#310). It moved four places in
step: `.node-version` (PR CI's Node, checked against `engines` by
`scripts/verify/toolchain-pins.test.ts`), `MIN_NODE` in `bin/claudin` (no test
pins it), the README badge and install line, and the comments in `tsconfig.json`
and `pr-checks.yml`.

**Why:** each step matched a dependency's requirement and was never an
independent choice. 22.12.0 (2026-06-05, commit 47c9ac3, from `>=20.0.0`) was
for commander 15, which is ESM-only. 22.19.0 is for undici 8.12, which binds
`zlib.createZstdDecompress` at load; Node gained it in 22.15, and 22.19.0 is
undici's declared `engines` (see [[dependabot-bumps-2026-10-19-undici-zstd-node-floor]]).

**How to apply:** don't lower it without pinning undici below 8.12, and below
22.12 commander to 14 as well. Raising the floor is a breaking change for
downstream users. Dev boxes run Node 24+, so only PR CI on `.node-version` catches
an API the floor lacks. Reproduce a CI-only failure with `mise install node@<floor>`
and that bin first on PATH.
