---
name: AGENTS.md documents the repo, never Claudin-only runtime behavior
description: Do not add rows for Claudin-only tool redirects, killswitch env vars or on-by-default gates to AGENTS.md — other harnesses read that file too; document them in the source module and .claudin/rules/
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

**How to apply:** when a review flags "this on-by-default behavior is
undocumented", the fix is the module header (name the env var there) plus a
`.claudin/rules/` entry if it changes how you write code — not a new row in the
AGENTS.md toggle table. `CLAUDIN_DISABLE_TOOL_REDIRECT` is documented at the top
of `src/tools/BashTool/toolRedirect.ts` on purpose.
