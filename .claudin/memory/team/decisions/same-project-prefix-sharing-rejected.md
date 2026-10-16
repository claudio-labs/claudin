---
name: same-project-prefix-sharing-rejected
description: The first message's static reminders stay behind the per-session scratchpad line, so a new session rewrites them; sharing them across sessions of one project measured ≤0.2% of main-thread spend on 2026-10-15 and was not built (same bar as env-as-system)
type: project
scope: src/providers/transport/api.ts
impact: rejected
---

**Decision:** The per-session element (`Scratchpad directory: …/<session-id>/…`)
stays the last, uncached system block (`splitSysPromptPrefix`,
`src/providers/transport/api.ts`). So everything after it is written again by
every new session, including the first message's reminders, which are the same
for every session of a project. These are CLAUDE.md, rules, memory indexes and
the tool/agent/skill listings. Sharing them was measured and not built
(user, 2026-10-15).

**Why:** the ceiling is too small for what the change touches.
`cross-project-cache-estimate.ts --since=2026-09-17 --same-project` counts a
start when another session in the same directory on the same model started
within the hour. Over 4 weeks that is 83 of 229 starts that wrote cache. The
saving is ≤ 2.7M of 1.67B list-price units, **0.2%** of main-thread spend. It
is an upper bound: it caps at 20k tokens of reminders and ignores memory edits
between sessions. The precedent bar is 5%:
[[claude-code-2.1.284-wire-diff]] item 2 rejected env-as-system at 0.1%. The
change would have needed four things:
- move the session element out of `system`, which the tests in `api.test.ts`
  and `sessionElement.test.ts` pin;
- reorder the reminders so git status follows the static ones;
- add a mid-message `cache_control`, which `addCacheBreakpoints` cannot place
  today;
- change the system string the OpenAI and Codex shims send.

**What changes for a teammate:** nothing. Re-measure with the same command if
session starts get much denser (for example, many short `-p` runs in one
repo). The turn-1 write on this repo is ~21k tokens a session (10-15).

**Evidence:** session-cache-ab `/tmp/session-cache-ab/20261015-211421`. The 9
first-message blocks hashed equal across reps, except the system prompt
(project paths) and the scratchpad line. The request-1 wire carries 3
breakpoints (2 system, 1 message).
