---
name: tool-error-census-2026-09-20
description: Tool error census 2026-09-14..20 (19.5k calls, 1,009 errors) — the read-before-edit family is 22% of errors and ~$70/wk; THREE harness bugs found AND FIXED on fix/tool-error-census-2026-09-20 (getChangedFiles reversed LRU recency; the watcher skipped every Read entry; post-compact plan unseeded), plus the served-region refusal, dedupExempt, the classifier stage-2 retry, Git head/tail, and a carry hole (outline source counted as seen)
type: project
---

Paired tool_use↔tool_result over every transcript modified since 2026-09-14
(300 files / 204 transcripts, deduped by tool_use id): **19,533 calls, 1,009
errors (5.2%)**. By design: 318 Bash redirect refusals, 113 plan-mode, 62
classifier denials, 19 user-rejected ExitPlanMode. Real errors ≈ 500 (2.5%).
Per tool: apply_patch 165/1131 (14.6%, up from 11.9% in 08-15), Edit 63/958
(6.6%), Git 68/929 (7.3%), Write 16/357, Read 42/6211 (0.7%), Grep 28/3730.
Reaction turns priced at $135/wk for the next call ($276 for two): redirects
$45, apply_patch read-gate $28→$60, classifier $11, plan-mode $9.

**Read-gate family = 219 refusals (apply_patch 172 bullets, Edit 40, Write 7),
root causes at path level** (scripts rebuilt in the session scratchpad —
`tool-error-census.ts`, `readgate-sequence.ts`, `coverage-replay.ts`,
`coverage-outcome.ts`, `neverread-why.ts`; ~40 lines each, rebuild rather
than hunt):

- **coverage 102**: 86 the model never Read those lines, and **52 are the
  import block** (Grep → Read(range) of the function → patch body + imports);
  14 seen only via Grep/Bash/Git output; 2 false refusals. Resubmit was
  byte-identical or ≤2 lines different in **56/111 (50%)** — the forced Read
  bought nothing there; 43 changed the hunk.
- **never-read 82**: blind 27, seen-via-grep 25, **wrote-then-lost 16**,
  read-then-compacted 5, via-bash 7. 30 are sub-agents patching from the
  parent's line-numbered brief.
- **stale 30** ("modified since read"): 19 after the model's own `sed -i`/
  awk/`bun -e` line-range deletions (file splits), 4 after `bun run build`'s
  in-place feature() pass (same bytes, new mtime), 2 after a sub-agent edited
  the file, 5 unexplained. 24/30 recovered with Read(range)+resubmit, 17
  identical.

**Three harness bugs behind the "lost state" numbers:**

1. `getChangedFiles` (services.ts) iterates `cacheKeys()` and calls `.get()`
   on every entry; lru-cache `get` moves to MRU, so each pass REVERSES the
   recency order and the file just written becomes the eviction victim on the
   next insert. Only bites past 100 distinct files (4 transcripts this week,
   88f03ef5 had 249) — reproduced with a 3-entry cache. Fix: iterate
   `entries()` / add `peek`.
2. The same watcher skips every entry with `offset !== undefined`, and a
   plain Read stores `offset: 1` — so it only ever watches files the model
   WROTE with a tool. A file only Read and then changed out-of-band is never
   refreshed → every stale refusal above. The TODO at services.ts:303.
3. Post-compact, the plan file is excluded from restore and re-injected as
   `plan_file_reference` without seeding readFileState → 5 Edits refused in a
   row right after compaction (8db7ab9b, flash-model 100k window).
   Also: `refreshChangedFile` evicts a file over the token cap on any mtime
   move, and the resulting "has not been read yet" sends the model to
   `view='full'`, which fails on the same cap.

**Other findings:** 55 "Classifier stage 2 unparseable" denials/wk, all
Opus, on long heredoc scripts (p50 400 chars, max 6 KB); never re-sent;
`maybeDumpAutoMode` is a no-op so the raw stage-2 text is invisible. Git
strictness 22: 13 trailing `| head/tail` (the Bash→Git redirect strips the
trim, then Git refuses it), 6 backtick/`$` inside `"…"` commit bodies.

**What landed (branch `fix/tool-error-census-2026-09-20`, 2026-09-20, one
commit per item, unpushed until hand-validated):** scenarios S6–S15 in
`src/__tests__/readGateScenarios.test.ts` first (7 red, then green one item at
a time); bug 1 (`changedFileCandidates` over `entries()`); bug 2 (range entries
refreshed in place without FileReadTool, slices re-verified, `dedupExempt` so
the re-read is never a `file_unchanged` stub); bug 3 (plan seeded post-compact
via `createPlanAttachmentIfNeeded(agentId, readFileState, deps)`; too-large
refresh leaves `refreshFailed: 'too-large'` + reason `changed-too-large`);
the served-region refusal (`src/tools/shared/servedRegion.ts`) for Edit and
apply_patch Update on never-read / partial-view / stale / coverage, exact +
unique only, ≤200 lines, never over a stand-down marker; classifier stage 2
retries once with 2× budget on `max_tokens`/empty and the denial reason now
carries `stop_reason` + output tokens; Git accepts a trailing `| head/tail`
(not on a watch — tail buffers and the idle watchdog would kill it). Found on
the way: `carrySeenRanges` carried an outline entry's raw source as a seen
slice at offset 1, so outline → Read(range) authorized a patch anywhere
(fixed, S15). 25 break-probes in `scripts/migrations/probes/toolErrorCensus.json`
all red; `break-probe.ts` now takes a list of suites. Live (headless
`claudindev -p` in a throwaway repo): Read(range) → `sed -i` → Edit passed
with no re-read; apply_patch on the import block was refused WITH lines
1–4 and the identical resubmit applied; `git log --oneline | head -3` ran.

**Why:** the previous censuses counted the family; this one shows a third of
its refusals are the harness losing state it had, not the model skipping a
Read.

**How to apply:** re-run `tool-error-census.ts --since=<next Monday>` and
count apply_patch coverage/stale refusals from before 2026-09-24 only — the
tool stopped issuing them that day ([[apply-patch-any-read]]) — and
expect stale ≈ 0, wrote-then-lost/compacted = 0, coverage and never-read
recovering in ONE call; if the import-block share is still high, the next
lever is the Read shape (Grep → Read(range)), not the gate. Watch the
`dedupExempt` rule in cache.md when adding any producer of range-shaped
entries. Related: [[read-gate-false-refusals-census-2026-09]],
[[apply-patch-failure-taxonomy]], [[weekly-token-census-2026-09-20]].
