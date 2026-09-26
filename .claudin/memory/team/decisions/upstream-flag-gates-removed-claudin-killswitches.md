---
name: upstream-flag-gates-removed-claudin-killswitches
description: Since 2026-09-25 no upstream remote-flag gate exists — all 94 inlined to the value they resolved to, the growthbook resolver and ~/.claudin/feature-flags.json are gone, and the upstream codename is out of every tracked file; the six features the fork had flipped on became CLAUDIN_* killswitches
type: project
scope: every former upstream flag read site; src/platform/analytics/ (deleted)
impact: structural
---

**Decision:** every upstream remote-flag gate (GrowthBook keys under Claude
Code's internal codename prefix) was removed on 2026-09-25: each read
became the value it already resolved to, per call site, and the branch that
could then never run went with it. `src/platform/analytics/growthbook.ts` went
last, so `~/.claudin/feature-flags.json` and `CLAUDE_FEATURE_FLAGS_FILE` are no
longer read (hard cut, like the #99 env rename). The six the fork had flipped
on became killswitches: `CLAUDIN_AWAY_SUMMARY`, `CLAUDIN_EXTRACT_MEMORIES`,
`CLAUDIN_EXTRACT_MEMORIES_EVERY` (15), `CLAUDIN_MEMORY_PAST_CONTEXT`,
`CLAUDIN_DEFERRED_TOOLS_DELTA`, `CLAUDIN_SCRATCHPAD`.

**Why:** there was no remote, nobody wrote the flags file, so every key was a
constant carrying Claude Code's internal codename into the shipped bundle
(~470 tokens in `dist/chunks/`). The user's rule: a feature that runs today
goes to the Claudin flag pattern, one that never runs is deleted.

**What changes for a teammate:**
- A new switch is a `CLAUDIN_*` env var read with `isEnvDefinedFalsy` /
  `isEnvTruthy` and documented in the module header — never a flag file.
- No tracked file outside `.claudin/memory/` may carry the codename:
  `src/__tests__/upstreamCodename.test.ts` fails otherwise, and it replaced
  growthbook.test.ts in the test-floor list. The census script and the
  strip-analytics codemod that needed the word went with it (git history).
  Test fixtures count: a `docs/tech/<codename>-census/…` path inside
  `lineBound.test.ts` (#252) turned main red until #253 renamed it
  (`cd6d5233`). A squash-merged PR title becomes a `CHANGELOG.md` line, so
  keep the word out of titles too.
- Deleted, do not go looking: `/keybindings` and user keybindings.json (off
  upstream), `/thinkback`, `/advisor`, `/ultrareview`, the streaming tool
  executor, session-memory extraction, the tool-result budget, the idle-return
  dialog, the env-less bridge. `docs/tech/upstream-flags/README.md` is the
  per-key ledger (keys listed without the prefix).

**Rejected:**
- Renaming the keys (`claudin_*` prefix or descriptive names): the suffixes are
  codenames too, and nothing needed to flip them.
- A `CLAUDIN_*` env for the 14 upstream on-by-default keys: rollback paths
  nobody here exercised.
- Keeping keybindings.json / streaming tool execution / the destructive-command
  warning as opt-ins: the user asked whether they were used; the gates were
  false and no doc mentioned them, so they went.

**Evidence:** pins in `src/agent/forkDefaults.test.ts` and
`src/memory/memdir/extractionDefaults.test.ts` (and the auto-mode / bypass
"stock install" describes) were added BEFORE the removal and held unchanged;
`scripts/migrations/probes/forkDefaults.json` turns all 15 red. Follow-ups
(dead at a distance) are listed at the end of the ledger.
