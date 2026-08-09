---
name: bash-file-read-census-and-redirect-reach
description: Measured 2026-08-09 — models read files via Bash in 38% of Bash calls, but 82-85% of that is Grep/Glob work, not Read work; the redirect converts 84.7% when it fires; Read-friction ruled out except on the error path
type: project
---

Census over 2,045 local transcripts / 71,621 tool calls, run 2026-08-09 after an
`apply_patch` was refused with "has not been read yet" for three files the model
had only seen through `Bash: cat`/`grep` (Bash output never populates
`readFileState`, so the read-gate refusal was correct).

**The numbers worth keeping:**

- **8,052 of 21,016 Bash calls (38.3%) read a file from disk** — find/ls 3,116,
  grep/rg 3,008, head/tail/sed 1,869, cat 943, wc 386. Rising: 33.7% (Jun) →
  37.2% (Jul) → **46.6%** (Aug). Sub-agents do it more than the main agent
  (41.6% vs 35.0%). 1,127 of them were followed by a `Read` of the SAME path
  (pure waste); 99 by a read-gate refusal for that path.
- **"Models use Bash instead of Read" is the wrong framing.** Classifying the
  8,630 all-time Bash file-reads by which tool actually owns the job:
  **Grep-shaped 53.9%, Glob-shaped 28.0%, Read-shaped only 15.3%** (2.9%
  wc/awk/stat — nobody's job). A first-verb sensitivity variant gives
  46.9/30.4/18.4/4.3, so Read-shaped is bounded at **15-18%** and the other
  82-85% is search and discovery. Widen `Grep`/`Glob` reach before touching
  `Read`.
- **Read friction is NOT the cause — measured, not assumed.** 92.6% of Bash
  file-reads are *cold*: no prior `Read` of that path at all. Read returns what
  was asked **91.1%** of the time (24,689 calls all-time; degraded 8.87%,
  7.5% post-cutoff), and the degradation is dominated by the auto-outline pivot,
  which the model recovers from *inside* Read: next move is
  `Read(offset/limit)` 18.0%, `Read(symbol)` 6.1%, `Read(view:full)` 4.1%, and a
  Bash read of the same path only **0.6%**. Two detectors disagree on the pivot
  count — a loose one says 3,236 pivots / 91 Bash follow-ups (2.8%), the strict
  `AUTO_OUTLINE_PIVOT_FOOTER` match says 1,699 / 11 (0.6%). **Cite the range,
  not either number**; the conclusion (no "Read → outline → Bash" loop) holds at
  both ends.
- **The one real escape hatch is the ERROR path, and it is tiny.** After a Read
  that *errored*, the next call is a Bash read of the same path **14.6%**
  (28/192) — about 25× the outline rate. But errors are only **0.78%** of all
  reads, so this explains ~28 Bash reads out of 8,630. And the top error is not
  Read holding information back: **"File does not exist" is ~29% of errors** (a
  wrong path guess), against ~7% for the real under-delivery case
  (`File content (35147 tokens) exceeds maximum allowed tokens (25000)`).
  There is no truncation bucket to count — FileReadTool has no truncation
  footer, so an over-cap read surfaces as that error instead.
- **Repeat reads are navigation, not failure.** Over 15,701 session×path pairs:
  1× 74.3%, 2× 14.0%, 3× 5.8%, 4× 2.6%, 5×+ 3.3%. Of the 8,989 extra reads only
  **10.1% repeat identical parameters** — 89.9% ask for a different range or
  symbol. The 5×+ tail is disjoint-range navigation of big files plus
  **re-reading a file the model just edited** (`streamParser.ts` ×13, 9 of them
  right after Edit batches), which the Read prompt already tells it not to do —
  a prompt line, i.e. the shape [[tool-result-nudges-benched-zero-adoption]]
  measured at zero adoption.
- **The refusal shape WORKS.** Of 144 redirect refusals, **84.7% became the
  suggested tool call** (Read 93, Grep 25, Glob 4) and **0% re-sent the
  identical Bash command** — the one-shot escape hatch has never been used.
  This is the counterpart to [[tool-result-nudges-benched-zero-adoption]]: an
  appended reminder gets 0 adoption, a *refusal naming the alternative* gets 85.
- **Reach was the whole problem.** Post-#36 the lane fired on only 3.6% of Bash
  file-reads, and replaying the real `analyzeCommandForRedirect` showed it
  declining 99.1% of the rest by its own logic — the wiring was fine, the
  analyzer was narrow. Gap structure: compound (`&&`/`;`) 67.8%, pipeline 12.9%,
  single command 10.4%, redirection/`tee` 8.9%.

**Fixed 2026-08-09** (`toolRedirect.ts`): a trailing trim consumer now folds into
a **Grep** head, not just a Read one — `| head -N` → `head_limit`,
`| sed -n 'A,Bp'` → `offset` (0-indexed, unlike Read's) + `head_limit`; plus
`-h`/`--no-filename` (grep only, single regular-file target — rg gives `-h` to
`--help`) and rg's `--no-heading`. Replay over the recorded gap corpus:
**26 → 141** of 2,804.

**Still deliberately out**, with the volume that justifies it: compound commands
(67.8% of the gap — a partial redirect would omit real work), `ls` (Read's own
prompt tells the model to use it), `tail -N` (31 single uses, no Read spelling
without a line count), `wc`/`awk`/`| sort`. `cd <dir> && <one read>` is only 20
occurrences — not worth path-rebasing for.

Corpus method: transcripts at `~/.claudin/projects/**/*.jsonl`; the replay needs
`bun test` (bunfig's stub aliases), a plain `bun` run dies on
`@anthropic-ai/sandbox-runtime`.
