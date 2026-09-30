---
name: first-request-dedup-memory-rules-on-demand
description: 2026-09-29 — each rule of the first request stated once, and the memory-writing rules sent only when a memory write breaks them (memoryFormatGuard.ts refuses malformed memory files); measured as the lean3 arm, no killswitch left
type: project
scope: prompts, memory
impact: functional
paths:
  - src/memory/memdir/memoryFormatGuard.ts
  - src/memory/memdir/teamMemPrompts.ts
---

**Decision:** the first request says each rule once (commit 1448fcea), and the v2 memory
section no longer carries the write-time rules — links, each team subdirectory's fields, the
index line; `memoryFormatGuard.ts` refuses a memory file whose frontmatter misses what its
place requires and hands those rules back with the refusal, and Write/Patch note a new memory
its `MEMORY.md` does not list (d41f4d79). Both are the default with no killswitch.

**Why:** an audit of the first request (branch `perf/prompt-parity-2284`) found "search
directly or delegate" five times, the no-double-work rule twice, a skill item naming a section
that does not exist, a ToolSearch example loading tools that are never deferred, Code and
Explore listings routing searches two ways, and parameter texts repeating their tool's
description. Measured together as the `lean3` arm of `/tmp/session-cache-ab/20260929-231527`
(N=5, Opus 5.5 medium, placebo arm): cost −4.7% against a placebo at −5.3%, turns equal, 25/25
sessions passing, first-turn context 17.7k → 15.8k (SEPARATED). The memory-write check
(`scripts/bench/ab/memory-write-ab.ts`, `/tmp/memory-write-ab/20260929-230343`) passed 12/12
like the full-rules baseline. The user decided no killswitch would outlive the A/B.

**What changes for a teammate:**
- A Write, Patch or staged rewrite of a memory file with an incomplete frontmatter is REFUSED
  on every family (an Edit only when it creates the file). A test fixture writing a memory
  must carry `name`, `description`, a valid `type`; a team decision also `scope:` and
  `impact:`; a file in `docs/` must be `type: reference`, in `bugs/`/`decisions/` `project`.
  Three memories in this repo already fail it (they fail the memory scanner too).
- Before re-adding a line to a prompt, check it is not said elsewhere:
  `src/agent/prompts/firstRequestDedup.test.ts` pins where each rule lives now.
- A memory-prompt change goes through `memory-write-ab.ts` as a `--variant`, since the session
  bench never writes a memory.

**Rejected:** refusing every first memory write to deliver the rules (a turn per session);
keeping the rules and only trimming them (the guard's refusal already has to carry them).

**Evidence:** plan `.claudin/plans/shiny-popping-spring.md`; [[claude-code-2.1.284-wire-diff]];
probes `scripts/migrations/probes/memoryFormatGuard.json` and `promptsV2.json`, every probe red.
