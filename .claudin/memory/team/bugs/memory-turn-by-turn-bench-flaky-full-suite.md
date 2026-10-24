---
name: memory-turn-by-turn RSS bench is flaky only under full bun test
description: scripts/bench/perf/memory-turn-by-turn-bench.test.ts "no late-session RSS blow-up" failed in full-suite runs but passed in isolation — two gate shapes, both fixed (negative first slope; 10-24 the 100 KB cut-over that lowered the ceiling); re-run in isolation before calling it a regression
type: project
paths:
  - "scripts/bench/perf/memory-turn-by-turn-bench.test.ts"
---

`scripts/bench/perf/memory-turn-by-turn-bench.test.ts > no late-session RSS blow-up under compact + clear` intermittently fails during a full `bun test` run but passes 3/3 when run in isolation (`bun --expose-gc test scripts/bench/perf/memory-turn-by-turn-bench.test.ts`).

**Why:** The assertion at line 62 is `expect(second.slope).toBeLessThan(first.slope * 5)`, taken only when `Math.abs(first.slope) >= 100KB`. Under full-suite GC/RSS pressure the first-half slope can come out strongly negative (RSS shrinking, e.g. ~-666 KB/turn), which makes `first.slope * 5` a negative threshold (e.g. -3.33M) that any non-shrinking second half (e.g. +726 KB/turn) can never satisfy. It's GC-timing/shared-global-state dependent — the same reason `test:coverage` runs at `--max-concurrency=1`.

**Second shape, fixed 2026-10-24 (PR #320, CI run 40048386818).** The negative case had been fixed by sending any first slope under 100 KB/turn to an absolute 1 MB/turn ceiling, and leaving `first.slope * 5` above it. That made the bound non-monotonic: just past 100 KB/turn the ceiling fell from 1 MB to 500 KB. CI failed a 677 KB/turn second half after a 134 KB/turn first (bound 668 KB). A flatter first half would have passed the same second half. The assertion is now one bound, `Math.max(1 MB, first.slope * 5)`, so a steeper first half can only raise it. The PR touched nothing the bench loads, and the file passed 3/3 in isolation.

**How to apply:** When a full `bun test` shows this as 1 of the failures, re-run the file in isolation to confirm it's the flake, not a real regression. The "2 known non-TTY ProviderManager Ollama/Vertex failures" this note used to pair it with are **gone** — they were misdiagnosed and fixed on 2026-07-08 ([[providermanager-tui-tests-fail-non-tty]]), so do not expect the old **3 fail** clean-tree baseline (6198 pass / 78 skip as of 2026-07-03). Re-measure before treating any count as the floor.
