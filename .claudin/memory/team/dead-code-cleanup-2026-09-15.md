---
name: dead-code-cleanup-2026-09-15
description: The dead-code + upstream-codename cleanup MERGED to main as PR #204 on 2026-09-16 (6d46ec9c) — what landed, the census it used, and the phases deliberately left behind
type: project
---

**MERGED 2026-09-16 as PR #204** (`6d46ec9c refactor(deadcode): remove the
analytics stack and dead-flag code (#204)`), after a same-day CI rescue: the
first run failed only on the two system-prompt characterization snapshots (the
prompt had drifted on the branch), which were re-snapshotted and pushed. The
branch lived one day — opened 2026-09-15 off `main` at `099b1469`, ~39+
commits, ~335 files, roughly −25k/+4k. `src/analytics/` and `src/telemetry/`
are GONE; `src/platform/analytics/` is down to `growthbook.ts` + its test.
Post-merge codename census: **326 occurrences across 158 files** (was 1654) —
the survivors are gate keys, wire-format names the VS Code extension expects,
and test fixtures. One PR at the end, one commit per category (the user chose
the single PR over the 5-PR split after hearing the bisect argument). Plan
file: `.claudin/plans/wild-wishing-wilkinson.md`.

## The distinction the whole plan turns on

The upstream codename prefix plays two roles and only one is dead: an **event name** (1st arg of
`logEvent`/`logEventAsync`) reaches an empty function, while a **gate key**
(`getFeatureValue_*`/`checkGate_*`/`getDynamicConfig_*`) is what a user writes in
`~/.claudin/feature-flags.json`. `scripts/build/build.ts:119-134` already draws
that line; a census script (new; deleted 2026-09-25 with the last gate) enforces it by classifying
**every** occurrence into event / gate / indirect / doc / unclassified, with
`unclassified` pinned at zero so nothing is missed by sampling.
Baseline 2026-09-15: 1654 → 1648 occurrences, events 1018 → 1000, 91 → 89
distinct gate keys. The docs now live at `docs/tech/upstream-flags/`.

## State at the end of 2026-09-15 — 39 commits, ~335 files, roughly −25k/+4k

**Fases 0-4 are COMPLETE.** Census 1654 → ~556 occurrences; **zero live event
names** (the 35 left are fixtures in two test files). Gate keys settled at
**105** after a validation round found the audit had enumerated 103 of 106 and
one of those was removable — details below.

The last five commits came out of a validation pass (build/typecheck/full
suite/privacy/deadcode all green, plus a tmux run of the real TUI), and what
they fixed is what a green gate does NOT catch:

- **A removed command still named in live strings.** The rate-limit footer read
  `… · /upgrade to keep using Claudin`, observed in the TUI with
  `ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0`. `getWarningUpsellText` is deleted;
  three more `/extra-usage` strings now name `claude.ai/settings/usage`.
- **`/feedback` was invisible in a stock install.** `isEnabled` gated on
  `isEssentialTrafficOnly()`, and Claudin defaults to essential-traffic, so the
  REPL fell through to skill resolution and said "Unknown skill: feedback". The
  gate was right while the command POSTed to Anthropic; b82f2df9 removed the
  upload and left it. Now `getExplicitEssentialTrafficOnlyReason()`.
- **Dead event-name parameters outlived their call sites.** 15 non-gate codename
  tokens were still shipping in `dist/chunks`, every one an event name threaded
  into a signature nothing reads: `respondToPendingRequest`'s `analyticsEvent`,
  `startBackgrounding(eventName)` in both shells, a REQUIRED
  `PrefixExtractorConfig.eventName`, `generateFileAttachment`'s two positional
  names. Down to two, both wire-format names the closed VS Code extension
  expects.
- **The census under-reported a third time**, and the second time with its
  `unclassified === 0` invariant green. Two blind spots: a key held in a
  file-local `const` and passed by name (no literal between the parens), and a
  token class with no hyphen (`off-switch`, `top-of-feed-tip` — the
  first refuses every non-subscriber Opus request). **A count that adds up is
  not a bucket that is right.**
- **`mcp/channelPermissions.ts` deleted** (240 lines + an `AppState` field):
  every export reachable only from inside the file, the one external reference a
  TYPE on a field nothing wrote or read. knip is blind to that shape — the type
  import is a real import of a real file.
- **The OpenTelemetry counter surface had no producer.** The slice that called
  `setMeter` was deleted; the accessors were not. All five setters were defined
  and called from nowhere, so eight counters and three providers stayed null and
  14 `getXCounter()?.add(…)` sites were permanent no-ops — cost, tokens, commits,
  PRs, lines changed, permission decisions. Gone with them: `vendor/otel.ts`
  (a local no-op shim so tsc could resolve the annotations), `bootstrap/state/
  telemetry.ts`, and `ActivityManager` entirely, whose three methods computed
  durations for a counter while nothing read its state. **`statsStore` sits in
  the same STATE block and looks identical — it is LIVE**, written from
  `interactiveHelpers.tsx`.
- **Tungsten**: `TungstenTool`/`TungstenLiveMonitor` are `= null` stubs and both
  imports of them were unused; five `tungsten*` `AppState` fields and one config
  field were declaration-only.

## The 44 off-map flags are NOT 44 dead branches — corrected 2026-09-15

44 of the 79 `feature('X')` names used in `src/` are absent from the
`featureFlags` map, so `featureFlags[name] ?? false` folds them to `false`.
An earlier note here called that 134 sites of dead code. **That was too strong**,
and a blanket sweep would have broken the build:

- **toolchain (4, must NOT be removed)** — `ALLOW_TEST_VERSIONS` is how
  `bun run smoke` reaches the 99.99.x install path (`bun --feature=…`);
  `IS_LIBC_MUSL`/`IS_LIBC_GLIBC` are compile-target pins `envDynamic.ts` falls
  back to runtime detection without; `HARD_FAIL` is a debug build option.
- **absent module** — gates a `require()` of a module this fork never received;
  the branch is already a build stub and costs a line.
- **dead local** — the real candidates. Each still needs its own trace: a flag is
  not proof, because a gated module can have a live side-door.
  `conversationArc.ts` sits behind `CONVERSATION_ARC` **and** is imported
  directly by `/knowledge`. `multiTurnContext.ts` (138 lines) has no such door
  and is genuinely dead.

`scripts/build/feature-flags-source-guard.test.ts` now enumerates the set and
fails on a new name — the ratchet, not the removal. **ULTRAPLAN is still not a
clean cut**: `RemoteAgentTask.tsx` imports `UltraplanPhase` from
`agent/ultraplan/ccrSession.ts` and `pillLabel.ts` renders `isUltraplan` /
`ultraplanPhase` off the live remote-agent task state. Also `BUDDY: true` sits in
the map with no `feature('BUDDY')` anywhere in `src/`.

Six came off the list by removal: `BUILDING_CLAUDE_APPS` (the /claude-api skill —
its 26 `.md` files are not in this fork, so enabling the flag would have
registered an empty prompt), `MULTI_TURN_CONTEXT`, `CCR_REMOTE_SETUP`
(`/web-setup`, which WOULD have worked if enabled — delete was the call, matching
what the branch already decided for the claude.ai consumer surfaces),
`SKILL_IMPROVEMENT` (a Haiku call writing to an `AppState` field no UI reads),
`STREAMLINED_OUTPUT`, `BREAK_CACHE_COMMAND`. **Now 38 off-map: 4 toolchain,
3 absent-module, 31 dead-local across 139 sites.**

Three left that are deliberately NOT taken, each for its own reason:

- **`HOOK_CHAINS` → `lifecycleHooks/hookChains.ts`, 1319 lines with 849 lines of
  tests.** Complete and tested, unreachable only because the flag is off the map.
  Enable-or-delete is a product call, not a cleanup one.
- **`UNATTENDED_RETRY` → the persistent-retry path in `withRetry.ts`.**
  `isPersistentRetryEnabled()` always returns false and is read at five sites,
  three of them inverted. Collapsing them touches backoff and keep-alive on the
  hot request path — worth doing, worth doing on its own.
- **`SLOW_OPERATION_LOGGING` → `AntSlowLogger` in `slowOperations.ts`.** Doubly
  dead: the flag gates the logger AND its sink is already a stub
  (`sessionArtifacts.ts`'s `addSlowOperation` has an empty body,
  `getSlowOperations` returns a frozen empty array).

The pattern worth keeping: **removing one flag exposes the next layer.** Deleting
`skillImprovement.ts` left `apiQueryHookHelper.ts` (141 lines) unreferenced, and
`deadcode:ci` caught it one commit later. Run the gate after every flag, not once
at the end of the batch.

**Zero orphan files remain.** All 3295 `.ts(x)` under `src/` were scanned for any
reference anywhere — imports, dynamic imports, requires, `mock.module`, plus the
bare path and basename in `scripts/` and the root configs. Every production file
is referenced. What is left is inside live files, which is the class
`deadcode:ci` (knip) cannot see.

`SystemMicrocompactBoundaryMessage` was the last orphaned type: in the persisted
`Message` union with a render branch, never constructed. Removed — microcompact
itself is untouched.

## Where it stood after the first 19 commits

**Fases 0, 1 and 2 are COMPLETE; Fase 3 is most of the way.** Census moved
1654 → ~1100 occurrences, events 983 → 169 across 27 files. The flag map lost
`AGENT_TRIGGERS`, `KAIROS`, `PROACTIVE`, `UDS_INBOX`, `BG_SESSIONS` and
`COMMIT_ATTRIBUTION`; eight names are still listed there awaiting the Fase 5
sweep. `missing-imports-baseline.json` went 103 → 51, re-captured each round —
**zero insertions is the signal that nothing broke**, deletions alone are fine.

- **Fase 2** — CHICAGO_MCP (`computerUse/`, 15 files that only compiled because
  DCE never walked into their `@ant/computer-use-*` imports), VOICE_MODE,
  CONTEXT_COLLAPSE, WEB_BROWSER_TOOL, AGENT_TRIGGERS_REMOTE, MCP_SKILLS, DAEMON,
  ABLATION_BASELINE, COWORKER_TYPE_TELEMETRY, UDS_INBOX, BG_SESSIONS,
  KAIROS+PROACTIVE (the largest — 242 sites, two delegated passes),
  COMMIT_ATTRIBUTION. Traps that held: `BriefTool/` is registered UNGATED and
  serves live BRIDGE_MODE; `useInboxPoller.ts` was misfiled under
  `terminal/voice/` and is the live swarm mailbox poller.
- **Fase 3** — `scripts/migrations/strip-analytics/` (29 tests) removed ~815
  call sites. See [[tests-observing-through-telemetry]] and
  [[typescript-7-no-classic-compiler-api]].

Still open at that checkpoint: ~28 codemod refusals (try/catch bodies,
`useEffect` bodies, the four member-calls inside `analytics/index.ts`), then
deleting the `analytics/` (minus growthbook) and `telemetry/` slices **with
their stub keys in the same commit**. **All of this landed before the merge** —
the slices are gone from main today.

## Originally landed (9 commits, 105 files, −4212/+2522)

- **Fase 0** — the characterization net, all four suites validated by
  break-and-restore. See [[characterization-net-before-deletion]].
- **Fase 1** — phantom `noop` command; `/feedback` repointed at this repo's
  issues with the `api.anthropic.com/api/claude_cli_feedback` POST and its whole
  transcript-gathering body removed; the upstream `claude/<codename>` MCP server name; `/upgrade`,
  `/extra-usage`, `/rate-limit-options` and `RateLimitMessage`; referral / guest
  passes / overage credit / `/passes` / desktop upsell; the survey stack and the
  auto-run `/issue` path; 17 eager imports of unregistered stub commands.

Gates green: build, smoke, typecheck zero, `verify:privacy`, `deadcode:ci`,
`test:floor` 22.95%.

## Left to do (post-merge, open follow-ups)

- **Fase 4a/4b — DONE 2026-09-25** by removing the gates outright rather than
  auditing them further: all 94 keys inlined to their stock value,
  `src/platform/analytics/` deleted, see [[upstream-flag-gates-removed-claudin-killswitches]].
- **Fase 5** — rules and docs. `.claudin/rules/typescript-patterns.md` rule 7
  mandates the `_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` suffix, which the
  codemod deleted; `search-strategy.md` teaches grepping `logEvent`;
  `testing.md` describes the `logEvent` mock leak. Also 65 `.d.ts` carry a
  boilerplate comment still naming `/upgrade` and `/extra-usage`.
- **38 off-map flags remain**: 4 toolchain, 3 absent-module, 31 dead-local
  across 139 sites — the ratchet (`feature-flags-source-guard.test.ts`) pins
  the set, removal is per-flag with its own trace. Three are deliberately
  parked: `HOOK_CHAINS` (enable-or-delete is a product call), `UNATTENDED_RETRY`
  (touches the hot request path), `SLOW_OPERATION_LOGGING` (doubly dead).

## Out of scope, decided

`src/platform/bridge/` (37 files) and `src/platform/teleport/` (10) stay:
BRIDGE_MODE ships true behind a claude.ai credential and both have 40+ live
importers. They only lose their `logEvent` calls.
