---
name: session-corpus-census-inflation
description: A grep-count census over ~/.claudin/projects/*.jsonl overcounts ~3x — subagent transcripts mirror the parent and the census conversation is itself in the corpus; also, redirected commands never reach the Bash filter, so "gap" needs pairing tool_use with tool_result
type: project
---

Learned 2026-08-23 sizing the Phase 14 bash-filter command gaps. Every headline
number from the first pass was roughly **3× too high**, and one whole item was
imaginary. Three separate causes, all invisible in a `Grep -c` over the corpus.

**Subagent transcripts mirror the parent's context.** A fork inherits the
conversation, so one Bash call is written once per fork. `gh api` appeared in
10+ files at 3 hits each — the *same* 3 calls. Any per-file match count sums the
same traffic N times, where N is however many agents were alive.

**The census conversation joins the corpus it is measuring.** While a fork
searched for `docker build`, it matched its own transcript 10 times. The
self-reference grows as you work, so a re-run reports *more* traffic for the
command you are investigating precisely because you investigated it.

**A redirected command never reaches the filter, so raw counts are not reach.**
This killed two of five planned items:
- `gh run view --log`, `gh pr view`, `gh pr checks`, `gh issue view` have been
  routed to GitTool since #53 (2026-08-05) — the 87k of `gh run view` counted was
  mostly sessions predating it, plus one-shot escapes.
- `pyright` and `bun run typecheck` are claimed by the Typecheck redirect
  (`src/tools/TypecheckTool/detect.ts` maps `/\bpyright\b/`). The largest
  "pyright capture" in the whole corpus is the refusal message.

**The method that works.** Walk each `.jsonl` once, index `tool_use` blocks by
`id` where `name === "Bash"`, then pair each `tool_result` back by
`tool_use_id`. That gives you (a) the real command string, so compound and piped
shapes can be excluded from an atomic-spec count, and (b) the result body, where
`"Blocked"` inside a `tool_use_error` tells you the call was refused rather than
run. Report **calls / blocked / ran** as three numbers, never one.

Measured this way: `bun run <script>` went 175 raw hits → **30 atomic calls, 29
ran**; `pyright` went "~10" → **2 calls, 1 blocked**; `docker build` went 10 →
**zero** (BuildKit output arrives via `docker compose up --build`).

**Why:** a filter spec is only worth writing for traffic that reaches the filter,
and three of the four gates between a grep hit and that point are invisible to
grep. Reporting the inflated numbers to the user first, and correcting them
mid-implementation, is how this was found.

**How to apply:** before sizing any new spec or redirect off the session corpus,
pair the calls and separate blocked from ran. And check the redirect allowlists
(`src/tools/*/redirect.ts`, `TypecheckTool/detect.ts`) *before* the corpus — a
command already routed to a tool is not a gap. See
[[token-bench-measurement-traps]] for the A/B-bench equivalents, and
[[bash-file-read-census-and-redirect-reach]] for the collector that sizes an arm
before it is built.
