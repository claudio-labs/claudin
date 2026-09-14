---
name: read-shape-steering-is-cost-neutral
description: Steering the model's Read shape from the prompt (outline/symbol/range vs whole file) moves the shape and does not move the bill — measured twice on Sonnet 5, and the Grep symbols nudge is inert in two different wordings
type: project
---

Measured 2026-09-14 with `scripts/bench/ab/read-strategy-ab.ts`, Sonnet 5, 13
repo-grounded questions, 3 reps per arm, A = `1f826b0a`, B = the prompt branch.
Two rounds were valid (3/3 usable, sentinel present, no sub-agents).

**The bill does not move.** Round 1: cost $2.998 → $2.879, `cache_read`
1,745,680 → 1,742,990 — a **0.15%** difference. Round 2: $2.698 → $2.637
(−2.3%), inside a per-run spread of $0.80-$1.02. That held while read SHAPE
moved a lot and while arm B did 24 reads per run against A's 32. **Read shape is
not a cost lever in this harness** — an optimization written against it is
optimizing a proxy that does not appear on the invoice.

**The prompt does steer the shape, including in the wrong direction.** A clause
reading `slice when you know where to look, not to explore` moved whole-body
reads from 32% to 40% of all reads, consistently (A 29/31/38% per run, B
38/42/39% — the arms barely overlap). It contradicted step 1 of the same ladder,
where opening an unknown file at `view='outline'` IS exploring. Removing it
closed the gap to 2 points. So the text works; it is the *direction* that needs
evidence, and a plausible-sounding clause can push the wrong way.

**Two wordings of a Grep `symbols` nudge were inert.** A preference ("reach for
symbols when you want to know WHERE something is used") and a capability
statement ("a match line does not carry the function it sits in") both measured
**zero** adoption: 0/43 vs 0/44 Grep calls in one round, 0/36 vs 0/34 in the
next, plus zero across 3 runs of `grep-rubric-ab` and a live tmux session. The
cost of carrying it was +135 bytes per request. What works on this axis is
`src/tools/GrepTool/autoPivot.ts`, which returns the symbol map by behaviour when
a search is broad — measured over 5,109 recorded results. Widen the mechanism;
do not write a third sentence.

**Bench traps this cost us, all three fixed in the script:**

1. **Sub-agent transcripts were not read.** They live at
   `<sessionId>/subagents/*.jsonl`. One baseline run delegated to three agents
   that did 93 of its 97 reads; counting only the parent inverted the published
   verdict (26%→21% became 18%→21%). A published result was retracted over this.
2. **`-p` is single-shot, so "one question per message" creates no turns.** It
   fragments the text across tool-call rounds and the sentinel gets lost: 5 of 6
   runs came back partial and the round was void. `cache-ab-bench.ts`'s
   `buildProseWorkloadPrompt` already documented this; free-paced works.
3. **`Object.values(modelUsage)[0]` takes one model.** It hid 8.19M cache-read
   tokens from a run, in the arm that then looked cheapest. Sum every key.

Also: the project dir is `sanitizePath` (every non-alphanumeric → `-`, 200-char
cap plus hash), not `replace(/[/]/g,'-')`, and it honours `CLAUDIN_CONFIG_DIR` —
getting it wrong returns all-zero counts that read as "the model used no tools".

Related: [[tool-result-nudges-benched-zero-adoption]],
[[prompt-tone-rewrite-unmeasurable]], [[token-bench-measurement-traps]].
