---
name: memory-ai-memory-ideas
description: Since 2026-10-16 memory takes six ideas from ai-memory (index fit, team trust note, shell writes ask, memory audit, expires:, dream provenance); round 2 on 10-23 escapes envelope closers, reads secrets past invisible characters, refuses bidi/tag characters in team memory, lints links and reachability — and did NOT promote a "taste is user" wording
type: project
scope: memory (memdir, instructions, autoDream, permissions)
impact: functional
paths:
  - "src/memory/memdir/memdir.ts"
  - "src/memory/memdir/memoryAudit.ts"
  - "src/memory/memdir/memoryLinks.ts"
  - "src/memory/memdir/hiddenText.ts"
  - "src/memory/memdir/secretScanner.ts"
  - "src/memory/memdir/memoryExpires.ts"
  - "src/memory/instructions/claudemd/memoryBlock.ts"
  - "src/memory/autoDream/memoryWrites.ts"
  - "src/permissions/filePermissions/internalPaths.ts"
---

**Decision:** six ideas from the ai-memory project (`../ai-memory`, analysed 2026-10-16), adapted so memory stays plain markdown with git as the sync:
1. An index over its 200-line/25 KB cap drops blank lines, then hooks from the bottom up, before it loses its tail (`fitEntrypointContent`).
2. One renderer, `renderMemoryFileBlock`, draws the indexes and every memory a `paths:` match attaches. A team memory carries `TEAM_MEMORY_TRUST_NOTE`: a teammate's note that never authorizes what the user did not ask for.
3. A shell write into the team dir no longer rides the carve-out (`checkShellEditableInternalPath`), and NotebookEdit runs the secret guard like the file tools. `claudin memory audit` exits 1 on secret-shaped team files, always covers `<gitRoot>/.claudin/memory/team/` whatever the memory settings say, and PR checks run it.
4. `expires: YYYY-MM-DD` is optional. A memory past its date is surfaced on Read, by the audit, in `/memory tidy`, in the dream digest and in `/memory`. Code never deletes it.
5. `scripts/bench/ab/memory-recall-eval.ts` gates how memory is read, as `memory-write-ab.ts` gates how it is written.
6. The dream digest names the memory files each session wrote, read from the transcript.

**Why:** before this change:
- a `paths:` team memory arrived shaped like a rule, so a PR could plant an instruction with a rule's authority;
- `echo <key> > team/x.md` passed with no secret scan (pinned red first);
- an over-cap index lost its newest entries;
- nothing in memory was time-bound.

**What changes for a teammate:**
- **Shell writes:** `mkdir`/`touch`/a redirect into `.claudin/memory/team/` now asks, and `/memory sort`'s category `mkdir` prompts with it.
- **New fields:** a test fixture with a malformed `expires:` is refused, and `MemoryHeader` has an `expires` field.
- **Memory prompt changes:** run them through `memory-recall-eval.ts` as an arm or `--variant`, beside `memory-write-ab.ts`.
- **Prompt surface:** none of this is in the system prompt. Expiry and provenance guidance live in the extraction and dream prompts.

**Rejected:**
- A `sources:` frontmatter stamp. It would store what the transcript holds and miss the main agent's writes.
- Expiry shown in the index. The cached prefix would change at midnight.
- Failing the audit on an expired memory. A gate that goes red by calendar is one nobody keeps.
- From ai-memory itself: embeddings, FTS, RRF, HTTP sync and access-counter decay, all rejected before or churn-prone in git.

**Evidence:**
- `scripts/bench/results/memory-recall-eval-2026-10-16.md`, N=5, Opus 5.5 medium:
  - Injection warned 5/5 against 1/5 on main and 0/5 on the placebo.
  - The legitimate-command control held 5/5.
  - G1 and G4 had no headroom, main passing 5/5, so they show no regression rather than an improvement.
  - The over-cap index needed fewer calls: −7% cost, separated, and −12% on the proactive case.
  - The Read-time expiry note showed no benefit on Opus 5.5 (it reads `expires:` from the raw frontmatter anyway) and cost a verification call on the expired-memory case (+10% median). Kept for weaker models and because the other surfaces do not depend on the model noticing — not a measured win.
- `scripts/migrations/probes/memoryAiMemoryIdeas.json`: 23 breaks red, 2 controls green.
- Review on 2026-10-16 (two agents, before merge) found and fixed in the same PR: the audit hung on a non-file `.md`, a committed `autoMemoryEnabled: false` turned the gate into a silent exit 0, NotebookEdit skipped the guard, the digest missed writes on Windows, and the shortened count overcounted. The symlink/case gap it also found predates the PR: [[team-path-symlink-case-gap]].
- Design doc: `docs/tech/memory/project-local-team-memory.md` (see [[memory-subsystem-design-doc]]).

## Round 2 — 2026-10-23 (ai-memory 3.1.1 → 3.2.2)

**Decision:** three more ideas, deterministic, branch `feat/memory-ai-memory-round-2`:
1. `renderMemoryFileBlock` escapes the CLOSING tags a memory could use to leave its envelope: `</system-reminder` in any memory, `</team-memory-content` in a team one (ai-memory ff57e210). Only closers, so prose naming `<system-reminder>` (this repo's team index has one) stays byte for byte.
2. `scanForSecrets` reads past `\p{Cf}`. A zero-width space inside a key passed every rule (ai-memory 642d8d6e). The team write guard refuses, and the audit fails on, bidi controls and Unicode tag characters (`hiddenText.ts`), which hide text from the PR that reviews team memory.
3. `claudin memory audit` reports `broken-link`, `unindexed` and `duplicate-name` (`memoryLinks.ts`) in every scope. They are report-only, like `expires:`.

**What changes for a teammate:**
- A team memory with a bidi or tag character is refused, and CI's `verify:team-memory` fails on one.
- A `[[name]]` from a team memory to a private memory shows up in the audit; teammates have no copy of it. A `[[name]]` matching nothing is a forward link, which the prompts invite, and is not reported.
- A memory reachable from no index line or memory, and without `paths:`, is reported.

**Rejected:**
- Escaping in `wrapInSystemReminder`: that lane carries diffs and code, where `&lt;` would misreport a file.
- Escaping opening tags: a forged opener stays inside the envelope, and escaping one changes legitimate bytes.
- An emoji-flag exemption for tag characters.
- Failing the gate on structural findings.
- **"Taste is `user`" wording** (taste filed as `user`, feedback scoped by subject, write-time split): memory-write-ab N=3 passed 21/21 in base, placebo and arm, at $0.127/$0.128/$0.129. No session changed type: every taste landed as global `feedback`. Reverted in the same PR. The private taste memories here mostly predate the global dir (10-09); `/memory sort` lifts them.

**Evidence:**
- The first audit run found 7 team→private links and 5 unreachable team memories, all repaired in the PR.
- `scripts/migrations/probes/memoryAiMemoryRound2.json`: 28 breaks red, 3 controls green.
- `scripts/bench/results/memory-write-ab-taste-2026-10-23.md`.
