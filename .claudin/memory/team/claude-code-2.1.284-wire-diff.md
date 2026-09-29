---
name: claude-code-2.1.284-wire-diff
description: Claude Code 2.1.284 vs Claudin captured on the wire (2026-09-29, interactive, Opus 5.5) — five structural differences PARKED for A/B by the user: total_tokens reminder, env in a role:"system" message, auto-mode Bash text, tool set, divergences Claudin already chose
type: project
---

Captured 2026-09-29 with `scripts/bench/tokens/extract-claude-code-prompt.ts` (local stub,
zero cost): Claude Code 2.1.284 against the `fix/prompt-parity-cc` build of Claudin,
interactive TUI, `claude-opus-5-5`, same empty cwd. The bugs and stale texts the same
capture found were fixed on that branch. The five items below are what the user
**parked for later, each behind an A/B** — do not ship any of them on a text diff alone.
Predecessor: [[claude-code-2.1.270-prompt-diff]] (prose from `strings`, no wire).

1. **`<total_tokens>N tokens left</total_tokens>`** ends Claude Code's system prompt and its
   first-turn system message (N = 15000000 in the capture). In the binary it is the
   `@internal` setting `totalTokensReminder` (`off | infinite | fixed | countdown |
   padded-countdown`), emitted in the system prompt, after every tool result and, with
   `totalTokensReminderAfterUserTurn`, after every user prompt. `fixed` prints 5000000,
   `infinite` prints "Infinite", `countdown` the live remaining context window,
   `padded-countdown` counts down from `totalTokensReminderBudget` and re-anchors on each
   user prompt ("task-budget semantic") — 15M fits padded-countdown. Claudin has nothing
   like it (its TOKEN_BUDGET paragraph only covers a target the user sets). The most
   promising A/B: a budget signal for the Claude 5 family — does a session wrap up
   earlier without it?
2. **The environment leaves the system prompt.** cwd, git, platform, OS, model and cutoff,
   the deferred-tool list, agent types, skills and the date go into a `role: "system"`
   message AFTER the user's prompt (beta `mid-conversation-system-2026-04-07`); the system
   prompt stays static and one block of it is cached with `scope: "global"`. Claudin keeps
   env in the system prompt and the rest as `<system-reminder>`s before the prompt. This is
   the "mid-conversation trio" already deferred in [[claude-code-beta-gap-2026-09-22]] —
   it needs its own cache A/B.
3. **Auto mode.** Claude Code came up in auto mode with a fresh config (beta `afk-mode`),
   and its whole auto-mode text is now one paragraph: do much of the work through Bash —
   "read files with cat, head, or sed -n, search with grep and find", small edits with
   sed or heredocs "instead of the dedicated Read, Edit, or Write tools". That is the
   opposite of Claudin's Bash description (Read not cat, Edit not sed) and unlike
   Claudin's six-point "Auto Mode Active" reminder. Claudin's cat-as-read arm measured +6%
   ([[cat-read-and-batch-read-ab-2026-09-24]]), so the lean is to keep Claudin's stance; an
   A/B would test Claude Code's text as a whole, in auto mode on both arms.
4. **Tools.** Claude Code sends 24: no Glob, no Grep, no TaskCreate/Get/List/Update/Output.
   Claudin sends 43. Eager on Claude Code: Agent, AskUserQuestion, Bash, Edit, ListAgents,
   Read, ReportFindings, ScheduleWakeup, Skill, ToolSearch, Workflow, Write, plus a
   `DeferredToolPlaceholder` stub — the deferred tools stay out of `tools` until ToolSearch
   loads them. Claudin defers AskUserQuestion although its own system prompt tells the model
   to use it when a call is denied: the cheap candidate here.
5. **Divergences Claudin already chose** — listed so nobody "fixes" them to parity without
   re-opening the decision. Sub-agents run inline in Claudin, while every Claude Code
   sub-agent runs in the background and forks only on `subagent_type: "fork"`
   ([[fork-subagent-by-default]]). The main-thread cache is 1h in Claudin; Claude Code on an
   API key used 5 min and no cache_control on the identity block (the capture was API-key,
   OAuth may differ). Claudin sends `block_binding: drop_block` on Opus 5.5, Claude Code
   does not — deliberate per [[claude-code-beta-gap-2026-09-22]].

**Why:** the user wants parity only where a measurement says it pays. Size already ties —
≈46k characters the model reads on the first request for Claude Code, ≈47k for Claudin —
so these are behavior levers, not size levers ([[prompts-v2-2026-09]]).

**How to apply:** re-capture before any of these A/Bs, since Claude Code ships weekly:
`TMPDIR=<scratch> bun scripts/bench/tokens/extract-claude-code-prompt.ts
--model=claude-opus-5-5 --out=<dir>`; for Claudin add `--bin=<checkout>/bin/claudin
--config=<dir>` with a config.json whose anthropic profile has a fake apiKey AND a
`baseUrl` (without one the profile is dropped and the TUI opens the provider wizard), and
put that dir outside `<tmpdir>/cc-extract`, which every run deletes. The extracted text is
Anthropic's: keep it in a temp dir. Run the arms with
`scripts/bench/ab/session-cache-ab.ts --variant=…` ([[session-cache-ab-bench-2026-09-23]]).
