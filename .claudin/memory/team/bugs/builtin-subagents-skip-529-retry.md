---
name: builtin-subagents-skip-529-retry
description: A built-in sub-agent (Code, Explore, Plan, WebResearcher…) never retries a 529 overloaded error — FOREGROUND_529_RETRY_SOURCES lists 'agent:builtin' exactly while built-ins run as 'agent:builtin:<Type>'; found 2026-09-25, not fixed
type: project
paths:
  - "src/providers/transport/withRetry.ts"
  - "src/agent/promptCategory.ts"
---

**Symptom:** a 529 (overloaded) on a built-in sub-agent's request fails that
Agent call at once, while the main thread's own requests retry. Confirmed by
reading the code, not reproduced live.

**Where:** `FOREGROUND_529_RETRY_SOURCES` (`src/providers/transport/withRetry.ts`)
holds `'agent:builtin'`, and `shouldRetry529` tests membership exactly. Every
built-in runs as `agent:builtin:${agentType}` (`getQuerySourceForAgent`,
`src/agent/promptCategory.ts`), which never equals it; `agent:custom` and
`agent:default` do match.

**Why it matters:** the set's own comment says it lists the sources the user is
blocking on, and an inline sub-agent's parent is. Since 2026-09-25 Explore is on
by default ([[explore-agent-removed]]), so more delegations run through a
built-in and a capacity spike fails more of them.

**Status 2026-09-25:** left in place, out of the Explore PR's scope. The fix is a
prefix match; mind the set's warning that every retry during a capacity cascade
is 3-10× gateway amplification.
