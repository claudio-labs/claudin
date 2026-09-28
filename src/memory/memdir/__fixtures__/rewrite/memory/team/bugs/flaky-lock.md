---
name: flaky-lock
description: The lock test fails about once in forty runs under parallel load; left in place behind a retry
type: project
paths:
  - "src/locks/**"
  - "test/locks/lock.test.ts"
---

**Symptom:** `acquires the lock once` times out when the suite runs in parallel.
**Where:** src/locks/fileLock.ts, on the release path.
**Repro:** run the suite with eight workers, forty times in a row.
**Status:** open, held by a retry since 2026-09-02.
**Why not fixed:** the fix belongs to the lock redesign planned for next quarter.
