---
name: prompt-tone-rewrite-unmeasurable
description: Rewriting the shouted IMPORTANT/NEVER emphasis out of the tool prompts was measured and dropped — the corpus shows no over-compliance, and empty thinking blocks make it unmeasurable from logs at all
type: project
---

A prompt-parity audit (2026-09-13) proposed rewriting the ~13 shouted emphasis
markers in `src/tools/BashTool/prompt.ts` and the prohibition-shaped tool list
("Read files: Use Read (NOT cat/head/tail)"), on the theory that capable models
**over-comply** with them: refusing a legitimate `grep` in a pipe, re-asking for
a confirmation already given, dodging `cd`. Measured over 142 session files
(23,697 assistant records, 16,234 tool_use calls, 3,391 Bash calls, paired
`tool_use`↔`tool_result`, `isSidechain` false throughout so no sub-agent
mirroring):

- **The model does not avoid the prohibited commands.** `grep` appears in 29.6%
  of Bash calls (1,003), `tail` 1,096, `head` 917, `sed` 428, `ls` 472, `cat`
  255, `find` 110. `cd` in 387 (11.4%), of which 276 are the sanctioned
  `cd /abs && …`. No splitting to dodge it.
- **No refusal prose and no redundant confirmation.** 0 true positives for
  "avoid/instead of/cannot use + grep|cat|cd|find" across all 857 text blocks;
  the 59 blocks that ask permission are end-of-turn next-step offers, not
  re-confirmations of what was just requested.
- **Harness refusals are a separate, real 9.0%** (305/3,391): Read/Grep filter
  81, RunTests 69, permission classifier 43, other `Blocked:` 41,
  Typecheck/Build/Git 37, plan mode 34. Subtract these before reading any other
  rate — they are claudin refusing the model, not the model refusing itself.
- One non-null but confounded signal: unix-tool use drops 86.4%→81.7% after a
  session's first redirect (−4.7pp, z≈2.6), and the next call after a redirect
  is the correct Grep/Read 89% of the time. That is compliance working, not a
  clumsier route.

**Why it cannot be settled from logs either way:** 6,639 `thinking` blocks
persist with **zero characters**. The deliberation where over-compliance would
live is not recorded, and a model does not narrate self-censorship in
user-facing prose. Logs can measure refusals *of* the model; they structurally
cannot measure the model's suppressed intentions.

**Decision:** the tone phase is dropped, not deferred. Re-open it only with a
graded A/B over a fixed task set scoring legitimate-`grep`-in-pipe and
unnecessary-confirmation rates — and expect it to come back null. The
contradiction fixes that shipped alongside this measurement
(`refactor(prompts): single-owner delegation rules, leaner git body`) were worth
doing on their own evidence; the tone rewrite was not.

Related: [[tool-result-nudges-benched-zero-adoption]],
[[session-corpus-census-inflation]], [[bash-file-read-census-and-redirect-reach]].
