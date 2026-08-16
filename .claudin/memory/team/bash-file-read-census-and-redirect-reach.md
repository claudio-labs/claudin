---
name: bash-file-read-census-and-redirect-reach
description: Measured 2026-08-09 and re-measured 2026-08-15 — 82-85% of Bash file-reads are Grep/Glob work, the refusal converts 84.7%, and the reach queue now has a standing collector; BRE translation alone is 40% of all redirects
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
  that *errored*, the next call is a Bash read of the same path — but **the
  14.6% (28/192) originally recorded here was wrong twice over**, and it is what
  seeded the rejected PR #67. Re-counted 2026-08-09: there are **193** Read
  errors, and 14.6% counted Bash merely *mentioning* the path; Bash actually
  *reading* it is **6.7%**. The ratio to the outline rate survives (~20×), the
  absolute does not. The error-class split was also wrong: **"File does not
  exist" is 46.6%** of errors (not ~29%) — it is the largest class by far — and
  over-cap is **34 of 193** (17.6%), not 13. There is no truncation bucket to
  count: FileReadTool has no truncation footer, so an over-cap read surfaces as
  that error instead.
- **Do not re-derive a Read fix from the error path.** All 28 over-cap reads
  eligible for a head-window fix were machine-generated scratch — agent task
  outputs, tool-result spill, /tmp review diffs, `dist/` bundle chunks. Zero
  user source or data files, 0.11% of 24,741 Reads. PR #67 was closed on this.
  See [[auto-outline-pivot-false-cap-claim]] for where the volume actually is.
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

## 2026-08-15 — the queue has a standing collector, and the gaps were capability gaps

`scripts/bench/perf/bash-redirect-gaps.test.ts` (`CLAUDIN_BENCH=1 bun test …`)
replaces the hand-run probe: it walks every transcript, asks the REAL
`analyzeCommandForRedirect` for a verdict, and buckets the non-redirecting
commands by a best-effort reason with samples. Over **2,032 sessions / 23,388
Bash calls**: 6,451 read/search calls (27.6% of Bash), **1,006 redirect
(15.6%)**, 5,445 run in the shell, 308 skipped for a cwd that no longer exists.

The round that produced it started from ONE session where 0 of 6 Bash calls
redirected. Re-asking *why the model went to the shell* — instead of "why is the
mapper narrow" — flipped the diagnosis: **4 of the 6 were capabilities Grep/Glob
did not have**, not disobedience. That is the question to ask of this report.

What landed, sized by the collector's own breakdown of the 1,006:

- **BRE→ERE translation is 40% of ALL redirects (405).** `breToEre.ts` translates
  `grep`'s default dialect instead of standing it down (`\|`→`|`, `\{n,m\}`→
  `{n,m}`, the positional `^ $ *` rules, refusing back-refs/`\<`/`[\w]`/stacked
  repetition). Equivalence is pinned by a **differential** test that runs the BRE
  through the real `grep` and the TRANSLATOR'S OWN OUTPUT through the vendored
  rg over a fixture and demands identical lines — feeding it the table's
  expected value instead would let a wrong translation pass, verified by
  mutation.
- **`find -iname` → `Glob(-i: true)` is 35.** Glob gained `-i` (rg `--iglob`,
  `src/shared/fs/glob.ts`), case-SENSITIVE by default — unlike Grep, whose
  default is smart-case.
- **`cat F | grep PAT` folding is 6.** A stdin grep is a `filter` role now, but
  only over an identity window: `sed -n '1,400p' F | grep` still stands down.
- Reach went roughly **560 → 1,006 (+80%)**.

**The bug this round found, worth its own rule of thumb:** a suggested `Grep`
that omits `-i` is NOT equivalent to the `grep` it replaces. GrepTool sends
`--smart-case` when the caller says nothing (`GrepTool.ts:470-476`), so a
lowercase pattern matches any case. `parseGrep` now always emits
`caseInsensitive`, and `false` is the load-bearing value.

**Rejected on cost:** `start_line`/`end_line` on Grep, to redirect
`sed -n 'A,Bp' F | grep`. Two fields in every request forever for a restriction
the model *invented* to bound output — it asked to scan the top of a file, not
to search lines 1-400. A tool the model would never reach for spontaneously does
not pay for its schema.

**Next queue** (non-redirecting, most frequent first): `ls` 1,236 and `tail` 643
are deliberate; `unclassified` 1,217 is dominated by commands whose file is
simply gone (`/tmp/*.log`), i.e. noise, not a gap; then shell
operators/redirection 813, `find` predicates 308 (`-maxdepth`, `-type d`, `-o`),
expansions 263, grep flags with no Grep spelling 267.
