---
name: memory-delta-removed-double-send
description: memory_delta was deleted 2026-08-07 because it re-sent the full body of every rule/CLAUDE.md that nested_memory had already sent the turn before (~57 KB/session here); the comment justifying the coexistence cited two things that are false in this fork
type: project
---

`src/utils/memoryDelta.ts` + the `memory_delta` attachment were removed
2026-08-07. They were not a delta on top of `nested_memory` — they were a second
full copy of the same files, one turn later.

**Why:** `nested_memory` emits `Contents of <path>:` with the whole body on the
turn a file is loaded. On turn N+1 `memory_delta` scanned the transcript for an
*announced hash*, found none (the raw attachment never carries one), and emitted
the same bodies again under `Nested memory files for this workspace:`. Observed
live five times in one session. The `injections.ts` comment defending the
coexistence rested on two claims that do not hold here: `getSystemBlocksWithScope`
does not exist in this fork (it survives only in comments), and the raw lane has
been session-deduped since `REPL.tsx:1578`. The delta's `removedNames` arm was
also unreachable — `current` is rebuilt from attachments that never leave the
transcript, so nothing is ever "removed".

**How to apply:** the saving is one full copy of every rule/`CLAUDE.md` a session
loads (58,717 B ≈ 14.7k tokens for the five rules that fired here). Before adding
any "delta" producer beside a raw one, verify the raw lane actually announces a
hash the delta can compare against — otherwise the delta is a duplicate, not a
diff. `src/agent/attachments/memory.dedup.test.ts` pins exactly-once through the
real producer and renderer; both of its guards were mutation-checked.
Related: [[per-turn-fs-scan-audit]] (a different memory lane — the relevant-memory
prefetch, gated off in the open build), [[dev-tooling-token-roadmap]].
