---
name: bash-redirects-advisory-dev-tools-deferred
description: Since 2026-09-24 Bash runs a command a dedicated tool could do and appends a note naming it, instead of refusing it once; Build/RunTests/Typecheck/WaitFor are deferred behind ToolSearch
type: project
scope: tools/BashTool + tools/ToolSearchTool
impact: functional
paths:
  - "src/tools/BashTool/redirectLanes.ts"
---

**Decision:** Bash's seven redirect lanes (tests, checks, builds, git reads,
file reads, `sleep` polls, blocking sleeps) no longer refuse. The command runs,
and `Tool.advise` appends a `<system-reminder>` naming the tool and the exact
call to its result, success or error. For a deferred tool that is not loaded
yet, the note also says which ToolSearch `select:` to call. Build, RunTests,
Typecheck and WaitFor are deferred (`isDeferredTool`, ToolSearchTool/prompt.ts).
Both are user decisions.

**Why:** the user wanted Bash to point, not block, and wanted ~11.5k chars of
schema off every request. The A/B ([[dev-tools-deferred-advice-ab-2026-09-24]])
measured no cost regression for either, 3 fewer turns than refusing, and
−3.3k prefix tokens per request.

**What changes for a teammate:**
- `CLAUDIN_BASH_REDIRECT=refuse` restores the one-shot refusals byte for byte,
  `=off` drops the notes, and `CLAUDIN_EAGER_DEV_TOOLS=1` puts the four tools
  back in the prompt. Each lane's `CLAUDIN_DISABLE_*_REDIRECT` works in every
  mode.
- Deferred, RunTests/Typecheck went unused in the A/B (0 of 18 sessions loaded
  them). The lanes skip `| tail`/`| grep` and compound commands, which is how
  the model runs tests, so the notes rarely fire for tests. Don't read a drop
  in RunTests usage in a census as a regression of something else.
- A census counting "redirect refusals" sees ~zero after 2026-09-24: count
  notes (`has a dedicated tool` / `only reads or searches files`) instead.

**Rejected:** a generic "Prefer the dedicated tools over shell commands" line
in the system prompt instead of the notes (measured, no different from the
notes or the placebo); keeping RunTests/Typecheck eager (the only arm where
they were used, at ~2.2k prefix tokens per request).

**Evidence:** runs `/tmp/session-cache-ab/20260924-143858` and `-150141`,
break-probe specs `bashAdvice.json` and `devToolsDeferredAdvice.json`.
