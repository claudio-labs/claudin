---
name: Node engine floor raised to 22.12.0
description: package.json engines.node is >=22.12.0 (was >=20) due to commander 15 being ESM-only
type: project
---

`engines.node` is `>=22.12.0` as of 2026-06-05 (commit 47c9ac3), raised from `>=20.0.0`.

**Why:** commander was bumped 14→15, which is ESM-only and hard-requires Node >=22.12.0. The floor was raised to match its requirement, not by independent choice.

**How to apply:** Don't lower it back to 20 without also pinning commander to 14 (14 has security support through May 2027). Anyone running Node 20 will fail to install/run — this is a breaking change for downstream consumers. The dev environment runs Node 25.9, so local builds won't catch a Node-20-only regression.
