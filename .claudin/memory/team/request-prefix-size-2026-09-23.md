---
name: request-prefix-size-2026-09-23
description: Why claudin's first request is 32.1k tokens vs Claude Code's 21.2k on Opus 5.5 — eager tools are the bulk (deferred schemas are sent but not billed at their size), per-tool usage over 14 days, and which trims are cheap vs behaviour-sensitive
type: project
---

Measured 2026-09-23 from mock captures (`scripts/bench/ab/resume-wire-probe.ts`)
and the session A/B ([[session-cache-ab-bench-2026-09-23]]).

| component | chars | ≈ tokens |
|---|---|---|
| 20 eager tools | 56.3k | 20.1k |
| 18 deferred tools (full schemas sent, `defer_loading: true`) | 44.3k | ~0.8k |
| system prompt block | 20.6k | 7.3k |
| `messages[0]` startup reminders | 10.0k | 3.6k |

Tokens at ~2.8 chars/token, calibrated on real Opus 5.5 usage (the 21,021-token
cross-session read is the tools array plus 120 chars of system); chars/4
undercounts by ~30%.

**Deferred schemas are sent but not billed at their size.** Adding
EnterPlanMode + ExitPlanMode (~7.4k chars) to the array measured +93 tokens
(`scripts/bench/ab/tool-search-cache-probe.ts`), so `shouldDefer: true`
(`src/tools/Tool.ts`) saves nearly a tool's whole size. The header of
`scripts/bench/tokens/eager-tools.ts` ("only stubs are sent") is wrong: full
schemas go over the wire and the API strips them. Deferral only applies on
first-party Anthropic; other providers get every tool inline. Claude Code's
21.2k includes ~16k chars of this machine's MCP instructions (context7), so its
core prefix is smaller still.

Eager tools, chars: Agent 11,386 · Grep 5,614 · Read 5,160 · apply_patch 4,178 ·
Build 3,788 · Typecheck 3,679 · Bash 3,108 · Rename 2,667 · Glob 2,501 ·
RunTests 2,481 · Git 1,782 · Skill 1,706 · WaitFor 1,593 · Edit 1,529 ·
ToolSearch 1,469 · Workflow 1,127 · Write 916 · Monitor 773 · WorkflowStatus 456
· ListWorkflows 356.

Usage 2026-09-09..09-23 (155 sessions, 132 in this repo), share of sessions:
Read/Grep/Bash 86/83/77% · Git 61% · RunTests/Typecheck 45% · Agent 42% (forks
1.3%) · Build 32% · WaitFor 30% (274 calls, broken —
[[waitfor-drops-optional-params]]) · Skill 15.5% · Monitor 2.6% · Rename 1.3% ·
Workflow/WorkflowStatus/ListWorkflows 0.

Candidates, ≈ tokens saved per request:
- defer Workflow ×3 + Rename, ~1.7k — low risk, nothing eager names them; DONE
  on `fix/session-cache`, first-turn context measured 32.1k → 30.4k;
- Agent description, ~1.3–1.8k — examples 3.7k chars, and its fork/fresh and
  foreground/background guidance repeats the system prompt; it carries the
  fork-vs-fresh A/B result and has never been A/B'd;
- git instructions reminder, up to 1.4k (`CLAUDIN_DISABLE_GIT_INSTRUCTIONS`);
  51% of sessions commit, so it needs an A/B;
- agent listing: the user's WebResearcher* descriptions are 1.6k of its 2.3k chars;
- defer Build/Typecheck, ~2.65k — HIGH risk: the Bash redirects name them, so a
  deferred target costs a ToolSearch round trip in 32–45% of sessions.

**Value:** the whole 11k gap is ≈ $0.05–0.10 per session on Opus 5.5, mostly
cache reads — the smallest of the three session-cache findings. Anything past
deferral should go through a `session-cache-ab.ts --variant` A/B first.

Tests that pin the prefix: `measure-tool-schemas.test.ts`, the system-prompt
characterization snapshots (need `dist/`; see
[[systemprompt-snapshot-harness-drift]]), the tools registry snapshot,
`AgentTool/prompt.test.ts`, `attachments.test.ts.snap`,
`measure-attachments-budget.test.ts`.
