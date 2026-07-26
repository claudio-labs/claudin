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
the Bash→Read/Grep/Glob redirect row for exactly this reason, and the sibling
Bash→RunTests row went the same way.

**How to apply:** when a review flags "this on-by-default behavior is
undocumented", the fix is the module header (name the env var there) plus a
`.claudin/rules/` entry if it changes how you write code — not a new row in the
AGENTS.md toggle table. `CLAUDIN_DISABLE_TOOL_REDIRECT` is documented at the top
of `src/tools/BashTool/toolRedirect.ts` on purpose.
