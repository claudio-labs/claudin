---
name: memory-turn-by-turn RSS bench is flaky only under full bun test
description: scripts/profile/memory-turn-by-turn-bench.test.ts "no late-session RSS blow-up" fails in full-suite runs but passes in isolation — not a regression signal
type: project
---

`scripts/profile/memory-turn-by-turn-bench.test.ts > no late-session RSS blow-up under compact + clear` intermittently fails during a full `bun test` run but passes 3/3 when run in isolation (`bun --expose-gc test scripts/profile/memory-turn-by-turn-bench.test.ts`).

**Why:** The assertion at line 62 is `expect(second.slope).toBeLessThan(first.slope * 5)`, taken only when `Math.abs(first.slope) >= 100KB`. Under full-suite GC/RSS pressure the first-half slope can come out strongly negative (RSS shrinking, e.g. ~-666 KB/turn), which makes `first.slope * 5` a negative threshold (e.g. -3.33M) that any non-shrinking second half (e.g. +726 KB/turn) can never satisfy. It's GC-timing/shared-global-state dependent — the same reason `test:coverage` runs at `--max-concurrency=1`.

**How to apply:** When a full `bun test` shows this as 1 of the failures, re-run the file in isolation to confirm it's the flake, not a real regression. Combined with the 2 known non-TTY ProviderManager Ollama/Vertex failures, a clean tree gives **3 fail** under full `bun test` (6198 pass / 78 skip as of 2026-07-03). None of the three are regression signals.
