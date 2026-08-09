---
name: bash-file-read-census-and-redirect-reach
description: Measured 2026-08-09 — models read files via Bash in 38% of Bash calls; the Bash→Read/Grep/Glob redirect converts 84.7% when it fires but only reached 3.6% of them; Read-friction was ruled out as the cause
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
- **Read friction is NOT the cause — measured, not assumed.** 92.6% of Bash
  file-reads are *cold*: no prior `Read` of that path at all. Of 3,236
  auto-outline pivots, only 91 (2.8%) were ever followed by a Bash read of the
  same file; the model's actual next move after an outline is
  `Read(offset/limit)` 1,240, `Read(symbol)` 549. So there is no
  "Bash refused → Read → outline → Bash" loop to fear, and widening the
  redirect is safe. Do not re-litigate this by intuition.
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
