---
name: dead-code-cleanup-2026-09-15
description: State of the refactor/dead-code-tengu-cleanup branch — what landed, the census that drives it, and the six phases still to run
type: project
---

Branch `refactor/dead-code-tengu-cleanup`, opened 2026-09-15 off `main` at
`099b1469`. One PR at the end, one commit per category (the user chose the
single PR over the 5-PR split after hearing the bisect argument). Plan file:
`.claudin/plans/wild-wishing-wilkinson.md`.

## The distinction the whole plan turns on

`tengu_` plays two roles and only one is dead: an **event name** (1st arg of
`logEvent`/`logEventAsync`) reaches an empty function, while a **gate key**
(`getFeatureValue_*`/`checkGate_*`/`getDynamicConfig_*`) is what a user writes in
`~/.claudin/feature-flags.json`. `scripts/build/build.ts:119-134` already draws
that line; `scripts/verify/tengu-census.ts` (new) enforces it by classifying
**every** occurrence into event / gate / indirect / doc / unclassified, with
`unclassified` pinned at zero so nothing is missed by sampling.
Baseline 2026-09-15: 1654 → 1648 occurrences, events 1018 → 1000, 91 → 89
distinct gate keys. Docs at `docs/tech/tengu-census/`.

## State at the end of 2026-09-15 — 19 commits, ~330 files, roughly −25k/+4k

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

Still open: ~28 codemod refusals (try/catch bodies, `useEffect` bodies, the four
member-calls inside `analytics/index.ts`), then deleting the `analytics/` (minus
growthbook) and `telemetry/` slices **with their stub keys in the same commit**,
then Fase 4a (audit the 84 surviving gate keys — a key being live is not the
same as the branch it opens working), 4b (collapse growthbook, see
[[growthbook-source-dead-stub-is-real]]) and 5 (rules, docs, baselines).

## Originally landed (9 commits, 105 files, −4212/+2522)

- **Fase 0** — the characterization net, all four suites validated by
  break-and-restore. See [[characterization-net-before-deletion]].
- **Fase 1** — phantom `noop` command; `/feedback` repointed at this repo's
  issues with the `api.anthropic.com/api/claude_cli_feedback` POST and its whole
  transcript-gathering body removed; `claude/tengu` MCP server name; `/upgrade`,
  `/extra-usage`, `/rate-limit-options` and `RateLimitMessage`; referral / guest
  passes / overage credit / `/passes` / desktop upsell; the survey stack and the
  auto-run `/issue` path; 17 eager imports of unregistered stub commands.

Gates green: build, smoke, typecheck zero, `verify:privacy`, `deadcode:ci`,
`test:floor` 22.95%.

## Left to do

- **Fase 1 remainder** — blocked on `claudin install`, see
  [[missing-module-stub-makes-dead-things-look-alive]].
- **Fase 2** — ~40 files behind the 14 false `featureFlags` (computerUse 15,
  voice 5 of 8, contextCollapse, RemoteTriggerTool, the KAIROS assistant chain,
  WebBrowserTool) plus ~300 `feature('FALSE')` call sites and the flags
  themselves. **Traps:** `BriefTool` is registered UNGATED and serves live
  BRIDGE_MODE; `terminal/voice/useInboxPoller.ts` is the swarm mailbox poller
  misfiled in that directory; `voiceModeEnabled.ts:20` is `return feature(…)`,
  the form that throws under `bun test`.
- **Fase 3** — a TypeScript-compiler-API codemod for the 1000 `logEvent` sites
  (all are statement position today — zero expression-position matches) plus the
  `analytics/` and `telemetry/` slices, ~6.7k LOC. Needs an AST-equivalence
  proof: it is the only possible guard for the Ink `.tsx` (`Config.tsx` alone has
  40 sites) that `bun test` cannot import.
- **Fase 4a** — audit all 89 gate keys empirically (FUNCIONA / QUEBRA / INERTE)
  by flipping each in a throwaway `CLAUDIN_CONFIG_DIR`. **Never in the real
  `~/.claudin`.**
- **Fase 4b** — collapse growthbook, see [[growthbook-source-dead-stub-is-real]].
- **Fase 5** — rules and docs. `.claudin/rules/typescript-patterns.md` rule 7
  mandates the `_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` suffix, which Fase 3
  deletes; `search-strategy.md` teaches grepping `logEvent`; `testing.md`
  describes the `logEvent` mock leak. Also 65 `.d.ts` carry a boilerplate
  comment still naming `/upgrade` and `/extra-usage`.

## Out of scope, decided

`src/platform/bridge/` (37 files) and `src/platform/teleport/` (10) stay:
BRIDGE_MODE ships true behind a claude.ai credential and both have 40+ live
importers. They only lose their `logEvent` calls.
