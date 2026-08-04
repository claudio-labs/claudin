---
name: Typecheck A/B benched flat — and the fixture cannot test the baseline
description: The 2026-08-03/04 TypecheckTool multi-turn A/B measured only −4 to −6% context, why the agent's own filtering absorbs the win, and the fixture flaw that makes the bench unable to exercise the baseline at all
type: project
---

`scripts/bench/typecheck-multiturn-ab.ts` (10 turns, sonnet 5, claudin release
vs the Typecheck build) was run twice: 120 errors in one file × 3 reps, then 600
errors across 60 files × 1 rep. **The token thesis did not hold.**

| | 120 err / 1 file | 600 err / 60 files |
|---|---|---|
| final context | −3.6% | −5.6% |
| cache create | −16.8% | −25.9% |
| cache read | +13% | +5.4% |
| check payload chars | −60% | −67.8% |
| cost usd | −20.7% | −13.6% |

Per-rep final context on the A side spanned 40.5k–48.7k, so a ~20% cost delta
over 3 reps is suggestive, not conclusive.

**Why the payload win does not become a context win.** Without the tool the
agent builds its own baseline and filters in the shell — transcripts show
`npx tsc --noEmit 2>&1 | tee /tmp/f | grep -c "error TS"; grep -iE "money|cart|tax" /tmp/f`
every turn, and on turn 1 once `git stash && npx tsc … ; git stash pop` (exactly
the tree-corrupting pattern `.claudin/rules/agent-safety.md` §1 warns about).
Its check payload stayed ~10.5k chars even when raw `tsc` output grew from 10k
to 56k: **the agent adapts its filter to the backlog, so the context cost of
checking is roughly constant regardless of backlog size.** That is the ceiling
on any payload-shrinking tool.

**The fixture flaw (fix this before benching again).** The pre-existing errors
live in `src/legacy/module*.ts` and none of the ten tasks touches that
directory, so `path` scoping alone excludes the whole backlog. The tool-side
agent noticed: it passed `baseline: "ignore"` on nearly every call — turning the
headline feature OFF and using the tool as a per-file filter, the exact
counterpart of A's `grep -v legacy`. **To exercise the baseline the fixture must
seed pre-existing errors in the SAME files the tasks edit**, where neither
`path` nor `grep` can separate new from old.

**Call-count difference is granularity, not waste.** B issued 18–19 calls to
A's 11 because B scopes one call per file (turn 8: three calls, turn 10: five)
while A runs one command per turn with a multi-alternative `grep -iE`. Fixed
2026-08-04: `path` now takes a string OR an array, and the DESCRIPTION says "one
call covering N files, never N calls" — the shell side always had `grep -iE
"a|b|c"`, so the tool needed the same reach. **Re-benched: adoption immediate
and correct** (18 → 11 calls; single string on the one-file turns 1–5, arrays of
3–4 paths from turn 6 on, one call per turn). **It changed nothing measurable**
— context +1.5%, cost 0.0%, check payload still −66%. Fewer calls cannot help
when the payload was already 3.4k chars; the delta lives in output tokens
(+32.9%), not in check results.

**The first turn is the tool's weakest moment.** Turn 1 edits a file, so the
tree is dirty, so no baseline can be recorded and the result says provenance
unknown — and the model responded by running
`git stash && npx tsc …; git stash pop` itself, the very pattern the tool exists
to replace (and that `.claudin/rules/agent-safety.md` §1 forbids). The headline
feature is unavailable exactly when an agent first reaches for it. Addressed
2026-08-04 by inheriting the baseline from an ancestor commit
(`baseline.ts`, state `inherited`) plus a DESCRIPTION bullet naming the
fallback.

**Third run, after that change: 0 Bash checks, 13 Typecheck calls, context
−13.3%, cost −15.9%, payload −82.8%** — the first run where every metric favours
B. But read the mechanism before citing it: **the ancestor fallback never fired
in this bench.** The fixture commits once and never advances, so there is no
ancestor to inherit from. What actually changed is that on turn 1 the model
reached for `baseline: "capture"` instead of `git stash`, which recorded a
baseline at HEAD and made turns 2–10 plain `matched` runs with a bare `{}` and
no `path` filter at all. Credit the DESCRIPTION wording, not the new code path.

**Fourth run (after `capture` started refusing a dirty tree): the model went
straight back to `git stash`.** Turn 1 is now, in order: `Typecheck {path}` →
`Typecheck {}` (both provenance-unknown) → `git stash` → `Typecheck
{baseline:"capture"}` → `git stash pop` → `Typecheck {}`. It popped, so nothing
was lost, and the baseline it got is *correct* — the tree really was clean at
capture time. But it is exactly the pattern `.claudin/rules/agent-safety.md` §1
forbids and that this tool exists to replace, and the refusal is what pushed it
there: run 3 got its baseline by capturing on a dirty tree (cheap, and silently
wrong) and run 4 pays two Bash calls to get an honest one. Tokens were
unaffected (ctx −12.4%, cost −16.9%, payload −82.8%, all within run-to-run
spread of run 3).

**Watch out: the bench's `checks NB/NT` counter missed it.** It classifies only
typecheck-shaped commands as checks, so `git stash`/`git stash pop` scored as
`0B` — the headline said zero Bash checks while the transcript showed the
forbidden pattern. Read the transcript, not the counter.

**Two independent runs now say turn 1 needs a first-class answer.** Whatever the
tool refuses, the model manufactures with shell commands. The remaining fix is
the one deferred at design time: reconstruct HEAD's baseline in a temp worktree
(`git worktree add --detach`) without touching the user's tree, so the first
check of a session never has to choose between an unknown answer and a stash.

**Fifth run, with worktree reconstruction: the cleanest transcript of the
series — 10 Typecheck calls, one per turn, zero Bash.** Turn 1's first call
reconstructed all 600 backlog diagnostics from HEAD and answered `0 new`, so the
model never flailed and never stashed. Cost −17.5%, payload −80.0%, but final
context only −1.2% (A also came in cheap that run at 42.2k).

Across five runs the deltas rank by stability: **cost is consistently −16 to
−18%**, payload −80 to −83%, context anywhere from −13.3% to −1.2%. Cite cost
and payload; do not cite context.

**Treat the deltas as noise until N≥3.** Three single-rep runs of the identical
fixture gave final context +1.5%, −13.3%, and (run 1) a figure in between, on a
per-rep A-side spread already known to span 40.5k–48.7k. The one signal that is
not noise is categorical: Bash check calls went 2 → 0, and no run since carries
`git stash`.

**Why:** the tool was justified on token savings; measured end-to-end it saves
little context, and its real defensible value is that the agent does not reach
for `git stash` to learn what is new.

**How to apply:** do not cite a context-savings figure for this tool. Rebuild
the fixture with overlapping errors before any further A/B. Bench runs die if
the parent turn is interrupted — launch with `setsid nohup … & disown`. See
[[typecheck-tool-baseline-design]] and [[clip-pin-cache-ab-2026-07-25]] for the
other bench-design traps.
