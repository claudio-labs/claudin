---
name: own-writes-next-census-checks
description: Own writes is ON by default since 10-21 (branch fix/own-writes-every-tool) — the next tool census must check what names-only lost; re-Reads and Edit misses after a claim from Git, formatter, build or sub-agent, claims on long calls, and that edited_text_file notes fell
type: project
---

**What changed (2026-10-21).** This applies after any call that may change files
(`tool.mayChangeFiles?.(input) ?? !tool.isReadOnly(input)`; Agent sets it to true):
- A read file whose mtime moved during the call is brought up to date.
- The result ends with one line: `(N file(s) you had read changed under this call — your
  read now matches the disk: …)`.
- The tool_result message carries `refreshedFiles`.

Before this, the next request got an `edited_text_file` note ("modified, either by the
user or by a linter") with a diff. `CLAUDIN_OWN_WRITES=0` brings that note back. Code:
`src/agent/attachments/ownWrites.ts`, hooked in `toolExecution.ts`. The numbers are in
[[edit-method-census-2026-10-21]].

**Why it needs checking.** The default rests on a branch-point replay:
- the next action checked the file in 0 of 40 samples, both with the notes and with the line;
- context was about 2% smaller.

Those samples were all the model's own python/sed edits, where it already knows the bytes.
For the sources below the diff told the model something it did not know, and now it gets
only the name:
- git checkout/stash/reset/rebase/pull: 588 of the 2,146 notes in Sep–Oct;
- a formatter the model ran itself (`biome --write`, `cargo fmt`). A PostToolUse formatter
  still gets the note, because the settle runs before hooks;
- the build's in-place preprocess and tests that write fixtures;
- an inline sub-agent's edits, which the parent now sees only as names in the Agent result;
- a user or IDE edit made during a long call, which is credited to the call. This is the
  known limit; for a sub-agent the window is minutes.

**Checks for the next census.** Run them on the first window after a release that ships
this, and compare with the Sep–Oct numbers in the census note.
1. `edited_text_file` notes per 1k tool calls should fall by most of the 95% share that the
   model's own calls caused. If they do not, the claim is not firing.
2. Count claim lines by source tool (Bash, Git, Build, RunTests, Agent, MCP) and, for Bash,
   by command class.
3. Re-Read rate: how often a claimed path is Read in the next 1–3 calls, split by source.
   Expect about 0 after Bash edits. A high rate after Git, a formatter or Agent means the
   diff was needed there.
4. Edit/Patch misses (old_string not found, hunk missed) on a claimed path before any Read
   of it, compared with the base rate on unclaimed paths.
5. Claims on Agent calls and on calls over ~60 s: count them, and hand-check a sample for a
   file that no tool in the call wrote (a user change that got absorbed).

**If check 3 or 4 is high for one source,** keep the diff for that source only (for example
Git or Agent) rather than switching the whole thing off. Names-only for every tool was the
user's call on 10-21.

**Method.**
- Pair tool_use with tool_result by id and dedupe by uuid ([[session-corpus-census-inflation]]).
- A claim is the `refreshedFiles` field on the transcript's tool_result message.
- The 10-21 scripts (`own-writes-census.ts`, `own-writes-replay.ts`) existed only in a
  session scratchpad and were never committed, so rebuild them from this description.
