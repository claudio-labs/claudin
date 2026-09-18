---
name: dead-code-round-3-2026-09-18
description: Third dead-code round — 14 commits, −7.7k lines; the knip production gate that now runs in CI, the three inventory claims that were WRONG, and what the round deliberately left standing
type: project
---

Branch `chore/dead-code-round-3`, cut from `main` at fe50dd2d on 2026-09-18.
**91 files, +330 / −7699**, 14 commits. Follows [[dead-code-round-2-2026-09-18]]
(PR #211) and consumes [[dead-code-round-3-plan-seed]], which is now spent —
groups A, D and the new E are done; B is untouched by choice.

## The gate landed first, and it works

`deadcode:prod` (`knip --production --include files`) now exists and **both**
knip gates run in `pr-checks.yml`, where neither ran before. What made it real
was the production `!` suffixes in `knip.json`: without them production mode
keeps no entry, negates every project pattern, analyzes **zero** files and
reports all 57 dependencies unused. Measured after the fix: **2 findings**, one
genuinely dead (`shared/types/hookEvents.ts`, deleted in the same commit) and one
permanent false positive (`shared/types/typeAssertions.ts`, now in `ignore` by
name). Default mode strips the suffixes, so `deadcode:ci` is unchanged — verified
at zero findings. Details in [[deadcode-gate-include-allowlist-hole]].

Still not done: `exports,types` in the default gate (~1349 findings, needs a
baseline ratchet that does not exist). That is the round-4 item.

## Three inventory claims were WRONG — re-verify before trusting a walk

[[unreachable-clusters-inventory-2026-09-18]] was right about 9 of 12 clusters
and wrong about these, all found by re-auditing against the live tree:

- **`permissionSync.ts` was test-pinned.** `src/__tests__/security-hardening.test.ts`
  reads the file as TEXT and required the six file-based functions to EXIST with
  `@deprecated`. Deleting them needed the test inverted to assert absence — which
  is what its own name ("file polling removed") always meant.
- **`generatedFiles.ts` was dead for a different reason.** `commitAttribution.ts`
  is live (11 importers); the import of `isGeneratedFile` was simply dangling.
- **`tmuxSocket.ts` was worse than reported.** `doInitialize` has no caller, is
  the only caller of `setClaudeSocketInfo`, the only writer of the socket state —
  so `getClaudeTmuxEnv()` provably always returned `null` and `bashProvider`
  branched on a constant. The whole feature was inert, not just its tail.

Also corrected: `sessionStoragePortable.ts` and `WelcomeV2.tsx` are alive, and
the dead `AnthropicUsage` is the **component**; a live interface of the same name
in `codexShim.ts` makes a raw occurrence count read as alive.

## Group E is new: concluded A/B instrumentation

The user's framing — "dead code we no longer use **nor use in A/B tests**" —
added an axis the reachability walk cannot see. Removed, each with its verdict
already recorded beside it: fork-clip history (+11% cost, disjoint ranges),
`CLAUDIN_TRAIL_CACHE_MARKER` + `CLAUDIN_ANCHOR_CACHE_HEAD` ($3.10 → $4.06),
`SERIAL_READ_NUDGE` (−6.3% against a −30% bar, adoption zero),
`CLAUDIN_PLAN_NOOP_GUARD` (1 no-op in 94 turns without it vs 3 in 85 with),
`CLAUDIN_DISABLE_READ_REMINDER_ONCE`, `CLAUDIN_MCP_INSTR_DELTA`,
`CLAUDIN_AGENT_LIST_IN_MESSAGES`.

**Kept on purpose**: `CLAUDIN_TOOL_PROMPT_TIER`, `CLAUDIN_WORK_CONTRACT`,
`CLAUDIN_ANTI_NARRATION` (the reusable one-build A/B mechanism — and
[[anti-narration-never-benched-on-claude-5]]), `SERIAL_EDIT_NUDGE`,
`CLAUDIN_ENABLE_WAITFOR_REDIRECT`, `CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION`.
Pending is not concluded. Every documented user-facing killswitch stays.

## Two bugs wearing dead code's clothes

- **The overly-broad shell allow-rule warning never fired.**
  `overlyBroadBashPermissions` was `const … = []`, returned unchanged and
  threaded through three files to a notification whose `length > 0` could never
  pass; both `isOverlyBroad*AllowRule` predicates had no caller. Worse, a comment
  in `permissions.ts` named one of them as the thing that "strips PowerShell(*)".
  No protection was lost — `findDangerousClassifierPermissions` covers a bare
  `Bash(*)`/`PowerShell(*)`, verified by reading it — but the comment was false.
- **The logo prefetch cost every launch.** `setup.ts` awaited
  `getRecentActivity()`, up to 10 session JSONL reads, into a cache whose only
  reader was the `LogoV2` the compiler output had nulled.

## Method notes

- `bun test --update-snapshots` was needed once: deleting `EmergencyTip.tsx`
  removed the last site of `tengu-top-of-feed-tip`, one of the two hyphenated
  gate keys, so the flag-resolution table moved. Same class as
  `checkRepoForRemoteAccess` in round 2 — a deletion that moves that snapshot is
  expected, not a red flag.
- `envNaming.test.ts` pins an inventory of `CLAUDE_*` tokens; `CLAUDE_SOCKET_PREFIX`
  left with `tmuxSocket.ts` and the entry had to go.
- The audit round found **no functional loss** but three things worth fixing: a
  both-arms assertion over the shipped flag map that now rested on the single
  `false` entry a bench is meant to flip; a gap in the inverted security test
  (`getPermissionDir` unlisted, fs anchor matching one import spelling); and four
  dangling doc/comment references. All closed in the last commit.
- Gate per commit: build, Typecheck (zero new), full `bun test`, smoke,
  `deadcode:ci`, `deadcode:prod`. Final: `rm -rf dist/chunks` then
  `verify:privacy`, `build:strict` (baseline unchanged — no re-capture needed),
  `verify:sdk-types`, `verify:rules`, `test:floor` (24.65% vs a 24.04% floor).
