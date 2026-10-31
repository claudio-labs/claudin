---
name: census-10-30-compaction-meta-ttl
description: Since 2026-10-31 deferred built-ins whose common call fits a line are listed with a call form and called without ToolSearch (CLAUDIN_DEFERRED_CALL_FORMS=0 reverts), and a one-shot -p run's main thread writes its cache at 5m (CLAUDIN_MAIN_CACHE_TTL=1h reverts); compacting a 1M thread early was measured on Opus and NOT promoted — −33% cost but 9× the edit-turn lookups
type: project
scope: src/tools/ToolSearchTool/prompt.ts, src/providers/shims/claude/cacheControl.ts, src/agent/compact/autoCompact.ts
impact: functional
---

**Decision (user, 2026-10-31, every model):**
- **On by default — call forms.** EnterPlanMode, ExitPlanMode, TaskList, TaskGet, TaskStop and
  TaskUpdate are listed as `Name — call directly: Name({…})`, and the listing's header and the
  ToolSearch prompt say such a tool is called without loading it. MCP tools never get a form.
  `CLAUDIN_DEFERRED_CALL_FORMS=0` lists names alone. The header is picked from the persisted
  lines, so an older transcript resumes byte for byte.
- **On by default — the -p tier.** `CLAUDIN_MAIN_CACHE_TTL` takes `1h`, `5m` or `auto`, and
  unset means `auto`: 5m for a one-shot print run (`-p` without `--input-format stream-json` or
  `--sdk-url`, `isOneShotPrint` in `clientType.ts`), 1h otherwise. A fork follows the main
  thread. `=1h` restores 1h everywhere.
- **Not promoted — compacting early.** No code changed; `large-window-compaction` has the run.

**Why:**
- **Call forms** (`tool-gaps-ab.ts --only=current,current-placebo,meta`, Opus 5.5, N=3, all
  hidden tests passed): ToolSearch-only requests 1,1,1 → 0,0,0, 45 direct calls and no error,
  meta-only requests median 5 → 2; median cost $1.228 against $1.302 and a placebo at $1.275.
- **The -p tier:** repricing the 40 `-p` sessions of the 10-30 A/Bs at 5m saves 13.3% (Sonnet)
  and 15.5% (Opus); their longest gap between requests was 74s. A live `-p` run with a 5.5-minute
  tool wait wrote every token at 5m and then read 17.6k back while writing 825 — the sub-agent
  keep-alive holds the main thread too. Interactive sessions pause: a replay of 10-25..30 with
  the main thread at 5m plus keep-alive cost +10% in writes, so they stay at 1h.
- **Compaction:** see [[large-window-compaction]], section 10-31.

**What changes for a teammate:**
- A bench is `-p`. `armEnv` (session-cache-ab and its reusers) and `runHeadless` pin
  `CLAUDIN_MAIN_CACHE_TTL=1h`; the other harnesses that build their own env now measure 5m, so
  their history before 10-31 is 1h (`scripts/README.md`).
- A new deferred tool whose common call fits on a line gets a `callForm`; `callForms.test.ts`
  checks every declared form against its own schema. The four dev tools got one later the same
  day ([[tool-repeat-calls]]).
- The "-p seeds tasks with TaskUpdate absent" bug filed on 10-30 never existed
  ([[tasklist-unordered-exitplan-seeds-without-ids]]).
