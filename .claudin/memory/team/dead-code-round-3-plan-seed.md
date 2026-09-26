---
name: dead-code-round-3-plan-seed
description: SPENT — the seed round 3 consumed. Groups A, C and D are done (see dead-code-round-3-2026-09-18); what survives here is group B, the ~9k lines that need a product decision, and the three claims re-verification proved wrong
type: project
---

> **Status 2026-09-18: groups A, C and D are DONE**, in the branch recorded at
> [[dead-code-round-3-2026-09-18]] — and three of the cluster claims below were
> WRONG when re-checked against the live tree (`permissionSync` is test-pinned,
> `generatedFiles` is dead for a different reason, `tmuxSocket` is inert
> end-to-end). Read that note before reusing any line item here. **Group B is
> the part still standing**, and it is the input to round 4.

Written 2026-09-18, right after PR #211 ([[dead-code-round-2-2026-09-18]]) went
up. **This is the input to the next plan, not the plan.** The findings live in
[[unreachable-clusters-inventory-2026-09-18]] and
[[deadcode-gate-include-allowlist-hole]]; this file is what to do with them and
in what order.

Everything below is **pre-existing**, not caused by PR #211.

## The four groups are four different kinds of work

Mixing them is what the user stopped mid-flight last round
([[removal-pass-only-provably-dead]]): a mechanical removal and a product
decision look identical in a diff and must not share a commit.

### A — Mechanical. Rot, no decision needed (~3.7k lines)

Delete-and-verify, exactly like PR #211's phases. In rough size order:
`terminal/logo/*` + `logoV2Utils.ts` (1482 — the React-Compiler output nulled
the `LogoV2` slot, so ten files have no importer at all),
`sessions/listSessionsImpl.ts` + part of `sessionStoragePortable.ts` (507),
`coordinator/swarm/permissionSync.ts`'s file-based half (374 — superseded by
the mailbox half, which is live), `settings/ui/Usage.tsx`'s `AnthropicUsage`
cluster (363 — superseded by `UsageGlobalScroll`), `shared/proc/tmuxSocket.ts`
(287 — beware the live NAMESAKE `isTmuxAvailable` in
`swarm/backends/detection.ts`), `agent/context/contextAnalysis.ts` (247 — a
duplicate of the live `context/analyzeContext.ts`, reached by a dangling import
in `compact.ts:41-43`), `agent/hooks/useTaskListWatcher.ts` (191 — imported by
`REPL.tsx:189` and never invoked).

Plus the export tail: the six confirmed second-order symbols in
`commitAttribution.ts` / `permissionSetup.ts` / `oauth/types.ts`, the newly
found `isOverlyBroadPowerShellAllowRule`, `src/shared/types/hookEvents.ts` (14
lines, dead — but NOT `typeAssertions.ts`, which is live test infra), and ~62
exports with a single repo-wide occurrence, clustered in
`providers/auth/auth.ts` (6), `providers/presets/providerDiscovery.ts` (4),
`vcs/git/git.ts` (4), `providers/effort/effort.ts` (3),
`shared/proc/platform.ts` (3). `migrateFromEnabledPlugins` wants its `export`
dropped, not deletion — it is still called in-file.

### B — Product decisions. Ask before touching (~9k lines)

Each is a complete, deliberate implementation that cannot run. The question is
always the same — **wire it, or drop it** — and it is never ours:

- `platform/bash/bashParser/` (~4.5k) — the Bash SECURITY walker behind the
  off-map `TREE_SITTER_BASH`, gate comment says "internal-only until pentest".
  [[bash-parser-unreachable-behind-tree-sitter-flag]] has the three outcomes.
- `entrypoints/sdk/` (~2.6k) — the whole SDK API is uncallable because the build
  has one entrypoint and `package.json` has no `exports`/`main`. Publishing an
  SDK entry is a product direction; note `generate-sdk-types.ts` reads these
  files as TEXT, so they are NOT safe to delete on a grep.
- `lifecycleHooks/hookChains.ts` (1319) — `HOOK_CHAINS`, parked on purpose.
- `agent/context/conversationArc.ts` (262) — every WRITER has zero callers, so
  the live `/knowledge` readers can only ever show an empty arc. This one is
  arguably group C.
- `platform/MagicDocs/magicDocs.ts` (183) — `initMagicDocs()` has an empty body.

### C — Bugs wearing dead code's clothes. The highest-value group

The precedent is `migrateFennecToOpus`: one startup migration of eleven that was
never wired — a bug, not rot. Two live instances, both of which make a shipped
feature silently record nothing:

- **`AttributionState.fileStates` is always empty.** `incrementPromptCount`
  fires on every prompt and `sessions/indexing/liteMetadata.ts` builds a resume-
  index chain from the snapshot, so the COUNT fields work while the per-file
  contributions never will. The only writer (`trackFileModification`) had no
  caller at any commit in this fork; recover it from
  `git show fee88d27^:src/vcs/git/commitAttribution.ts`. The type comment added
  in `82654577` says all of this in place.
- **`conversationArc` readers see an empty arc** (above).

Deciding these needs a product answer, but *finding* more of them is mechanical:
look for a live consumer reading a structure whose only writer is callerless.

### D — Gate changes. Do these FIRST or the rest recurs

`deadcode:ci` has never checked a single export, and no workflow runs it at all.
[[deadcode-gate-include-allowlist-hole]] has the measured specifics, including
why `deadcode:prod` as previously proposed analyzes zero files and reports all
57 dependencies unused. Ordered by value:

1. Fix `knip.json` with production `!` suffixes + four `ignore` entries, then
   wire `deadcode:prod` into `pr-checks.yml`. Measured: drops to 2 findings and
   **would have caught all five** modules PR #211 found by hand.
2. Add `exports,types` to the default gate **with a recorded baseline** (~1349
   today, most of it noise — apply the three guards from
   [[knip-unused-export-is-not-unused]]).
3. Run `deadcode:ci` in CI at all. It has "ci" in its name and lives only in the
   `/pre-pr` skill.

None of this can find group A or B, though — that class is
reachable-by-import and unreachable-by-execution, invisible to any import graph.
The reachability walk is the only tool that finds it, and
[[unreachable-clusters-inventory-2026-09-18]] lists the six false-positive
classes that make it lie before they are fixed.

## Sequencing constraint

**D before A.** Landing the gate first means group A's deletions are checked by
it rather than trusted. Then A in per-cluster commits, then C once someone
answers, and B only on explicit approval per item.

One hard mechanical constraint from last round: `bun run build` preprocesses
~175 source files IN PLACE, so it cannot overlap with any agent reading source.
Read-only audit agents can run in parallel; the moment one builds, sequence it
alone (then `.claudin/rules/agent-safety.md` §1, deleted 2026-09-24 — see
[[memory-cites-pre-reorg-paths]]).
