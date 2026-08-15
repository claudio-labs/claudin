---
name: AGENTS.md documents the repo, never Claudin-only runtime behavior
description: Do not document Claudin-only tool redirects, killswitch env vars or on-by-default gates in AGENTS.md — other harnesses read that file too; the toggle table was deleted 2026-08-15 and verify:rules now caps the always-loaded budget
type: feedback
---

AGENTS.md must describe the **repository** (layout, commands, conventions), not
Claudin's own runtime behavior. Tool redirects, `CLAUDIN_*` killswitches and
on-by-default gates belong in the source module's header comment, and — when
they are a coding rule — in `.claudin/rules/`.

**Why:** this repo is open source and AGENTS.md is read by every agent harness
that opens it (Claude Code, Codex, Cursor, aider, …). A row describing a
Claudin-only refusal reads to those harnesses as an instruction they cannot
honor, so it is worse than absent. Decided 2026-07-26: commit 606bf24 removed
the Bash→Read/Grep/Glob redirect row for exactly this reason.

**Correction 2026-08-04:** this memory used to add "and the sibling Bash→RunTests
row went the same way". That is false and cost a review round. `git log -S` shows
that row added in f74c5186 (2026-07-25, one day BEFORE the decision) and never
removed — it is still at AGENTS.md:98. The convention is nonetheless current, and
the proof is Typecheck: it landed 2026-08-04, nine days after the decision, with
no row at all. The Git tool followed Typecheck. Treat the RunTests row as a
leftover to delete, not as precedent.

**Resolved 2026-08-15:** the whole table is gone. Six of its eight rows were pure
deletions — the module already documented the toggle. The RunTests leftover
needed one paragraph added to `src/tools/RunTestsTool/redirect.ts` first (its own
row cited that file, where the env var never appeared; it is read in
`BashTool.tsx:550`), and `toolExecution.ts` had a comment that *delegated* to
"AGENTS.md's default-on table" and had to be made self-sufficient. What replaced
the table is one paragraph naming the behaviors and the rule that each is
documented at the top of its own module.

The same pass gave the convention a gate. `rulesLint` was counting only rule
files in the always-loaded budget, so AGENTS.md — 75% of that cost — was
invisible to the check meant to police it; root context files now count, and
`scripts/rules-check.ts` fails over `ALWAYS_LOADED_CHAR_BUDGET` (20,000 chars,
~20% headroom over the measured 17,058). When it fires, the fix is to move the
prose into a `paths:`-scoped rule, not to raise the number.

**How to apply:** when a review flags "this on-by-default behavior is
undocumented", the fix is the module header (name the env var there) plus a
`.claudin/rules/` entry if it changes how you write code — not a new row in the
AGENTS.md toggle table, which no longer exists. `CLAUDIN_DISABLE_TOOL_REDIRECT`
is documented at the top of `src/tools/BashTool/toolRedirect.ts` on purpose, and
that file's header is the format to copy.
