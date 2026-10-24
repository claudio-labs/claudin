---
name: patch-thinking-levers-not-promoted
description: Claudin keeps its batched-Patch edit flow — the 2026-10-21/22 levers against the extra thinking were measured on Opus 5.5 and Sonnet 5.5 and none became a default; CLAUDIN_LEAN_PATCH_PROMPT, CLAUDIN_SOFT_BATCH and the sed -n slice credit ship off like the cat credit, CLAUDIN_BASH_FIRST stays on the local branch perf/patch-thinking
type: project
scope: src/agent/prompts/steeringToggles.ts
impact: rejected
---

**Decision (user, 2026-10-22):** Claudin keeps today's file-editing flow: read the batch, then
land a multi-file change as ONE Patch. None of the levers built to cut the thinking around that
flow becomes a default.
- Three are in the code and off by default, the way the `cat` read credit already was. Unset,
  every prompt is byte-identical (#314):
  - `CLAUDIN_SOFT_BATCH`: ONE Patch, without "Read every file first";
  - `CLAUDIN_LEAN_PATCH_PROMPT`: the Patch description without the rules the parser rescues;
  - the `sed -n` slice read credit, which rides the same `CLAUDIN_BASH_READ_CREDIT` as the `cat`.
- `CLAUDIN_BASH_FIRST` (file work through Bash, as Claude Code does on Opus 5.5) stays only on
  the local branch `perf/patch-thinking` (`35ab977b`, `462a7bd9`), never merged.

**Why:** today's default is the more economical one in the mode people run it in.
- **Opus 5.5 high, auto.** Fixed bash-first edited like Claude Code: 0 patches, and a 1-file
  first edit. Its thinking was only −16% against placebo, inside the noise. In auto every Bash
  edit costs a classifier request, while Patch takes the fast path. That came to 12 classifier
  requests against 2–3, about +9% cost against placebo, and +18% turns.
- **soft** was −17% without a placebo.
- **Sonnet 5.5** has no gap to close: Claudin already edits through Bash there, and costs less
  than Claude Code.
- **Opus medium.** The 2× thinking gap was cost-neutral to begin with, since the thinking
  replaces visible text.

**What changes for a teammate:** nothing; every default is unchanged. The study is in
[[thinking-gap-is-patch-shape-2026-10-21]]. The session report
(`scripts/bench/ab/session-cache-ab.ts`) gained the rows that measure this: thinking by response
kind, thinking up to the first edit, first-edit size and patch misses. An arm is one
`--variant=<label>:CLAUDIN_…=1` away. The probe specs are `patchThinking.json` and
`sedReadCredit.json`.

**Reopen it when:** the classifier stops charging for Bash edits in auto mode, a placebo-gated
N≥8 Opus run puts bash-first beyond the noise, or latency to the first visible answer becomes the
goal instead of cost.

**Evidence:** session transcripts under `~/.claudin/projects/-tmp-session-cache-ab-20261022-*` and
`~/.claude/projects/-tmp-session-cache-ab-20261022-032941-claude-*`. The `/tmp` run dirs and proxy
recordings were lost to two reboots.
