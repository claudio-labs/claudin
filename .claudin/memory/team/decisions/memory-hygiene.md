---
name: memory-hygiene
description: Since 2026-11-01 memory cleans itself — audit hygiene findings, write-time notes, contradicts:, a dream that deletes merged/folded memories (on by default), tidy private→global, per-session extraction cursor + idle trigger; the dream never deletes to make room
type: project
scope: memory (memdir, autoDream, extract, tidy, write tools)
impact: functional
paths:
  - "src/memory/memdir/memoryHygiene.ts"
  - "src/memory/autoDream/**"
  - "src/memory/extract/extractMemories.ts"
  - "src/memory/extract/extractionCursor.ts"
  - "src/commands/memory/tidyPrompt.ts"
  - "scripts/bench/ab/memory-hygiene-eval.ts"
---

**Decision:** memory stopped only growing. Before this, the October census found the team
index at its cap for seven weeks, one user fact in five places, and no record of memories
that disagree. Nothing could clean them up:

- the dream could not delete a file;
- `/memory tidy` never merged across the global boundary;
- the audit saw a duplicate only by an identical name;
- the extraction never fired (0 requests in nine days).

What shipped on `feat/memory-hygiene`:

- **Findings.** `memoryHygiene.ts` reports near-duplicates (token overlap ≥ 0.5,
  calibrated on 291 real memories), `type: user` outside global, open contradictions,
  indexes over cap, and memories over 8 KB. They go to `claudin memory audit`,
  `/memory tidy` and the dream digest. They are reported only, never fail anything.
- **Write-time notes,** through the write tools' `advise`, so the system prompt is
  unchanged. They name the saved memory a new one reads like, ask a dated snapshot for
  `expires:`, and warn when an index goes over its cap.
- **`contradicts:`** frontmatter. A Read says it, and the audit reports it until someone
  removes it. A disagreement is settled from the code or the transcript, never from which
  file is newer.
- **The dream deletes, through a Patch its gate checks** (`prunePatchProblem`). It may
  delete a team memory freely. It may delete a private one only in the Patch that writes
  its survivor. It never deletes an index. In global it may only append. It is **on by
  default**, at most once a day after five sessions, and never in `-p` unless
  `CLAUDIN_AUTO_DREAM_HEADLESS=1`.
- **The extraction cursor is kept per session,** beside the transcript. The interval went
  15→5, and an idle trigger fires after 10 minutes.
- **Edit and Patch count a session `MEMORY.md` as read.**

`CLAUDIN_MEMORY_HYGIENE=0` turns off every model-facing part.

**Why:** measured in `scripts/bench/results/memory-hygiene-2026-11-01.md`, Opus 5.5, N=3.

- The hygiene eval went from base 0/3 to 3/3 on S3, E1, E2 and E3. The controls stayed
  intact, nothing in global shrank, and the dream cost a median $0.49 against $0.52.
- `snapshot` went 0/3 → 3/3.
- The existing write and recall cases did not regress: 21/21 and 24/24.

**Rejected / the trap:** the first run passed every pre-registered gate, yet every dream
deleted 50 thin notes nobody had retired. The digest's "retire what nothing needs" for an
over-cap index was the "index budget" option the user had rejected. The fix: never delete
to make room. The eval also gained **S4**, a hard check that nothing outside the planted
candidates is deleted.

A gate that only checks the controls cannot see over-deletion. Any future change to what
the dream may delete must keep S4.
