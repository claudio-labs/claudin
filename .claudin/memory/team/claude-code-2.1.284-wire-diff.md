---
name: claude-code-2.1.284-wire-diff
description: Claude Code 2.1.284 vs Claudin on the wire (2026-09-29) — the five parked differences, all decided the same day on perf/prompt-parity-2284: total_tokens parked (placebo band), env-as-role:system no-go (0.1%), auto-mode text not adopted, AskUserQuestion stays deferred; plus the first-request dedup (lean3) and on-demand memory rules that were promoted
type: project
---

**Outcome, 2026-09-29 (branch `perf/prompt-parity-2284`, one PR).** Every item below was
decided with a measurement; nothing ships on the text diff alone.
- **1, total_tokens — PARKED.** Re-capture: the line ends CC's system prompt on Opus 5.5,
  Sonnet 5.5 and Haiku 4.5, interactive and `-p`. Built as `CLAUDIN_TOTAL_TOKENS=1` (the static
  line, at the end of the Anthropic addendum). Session A/B `/tmp/session-cache-ab/20260929-231527`
  (N=5, Opus 5.5 medium, proxy): the line reached 76/76 requests and moved nothing — cost −4.4%
  against a placebo at −5.3%, one more turn. The user dropped the per-turn countdown before the
  run, fearing cache breaks; a reminder appended once to a tool result never rewrites the prefix
  (cache.md), so that fear is not the reason to skip it — the countdown is simply unmeasured.
- **2, env as role:system — NO-GO.** The API takes a role:system message after the prompt on
  Opus 5.5 with or without `mid-conversation-system-2026-04-07`, and the model obeys it
  (`scripts/bench/tokens/beta-acceptance-probe.ts`, arm `mid-conv-system*`). But the only gain is
  reusing another directory's cached prefix: `cross-project-cache-estimate.ts --since=2026-09-15`
  found 36 of 168 cold starts it would serve, 0.1% of main-thread spend, against a 5% bar set
  before measuring. session-cache-ab would overstate it (a fresh workspace per session).
- **3, auto-mode text — not adopted.** It is only the Bash-first paragraph, and cat-as-read
  already lost (+6%, [[cat-read-and-batch-read-ab-2026-09-24]]); the user closed it.
- **4, AskUserQuestion eager — rejected.** `scripts/bench/tokens/deferred-load-census.ts` over
  144 interactive sessions (19,876 requests): 26 round trips only to load it (72 with
  Enter/ExitPlanMode), and carrying the schemas eagerly would cost +0.85M input-token units more
  than those trips (~0.1% of spend). Fewer calls at a higher cost; it stays deferred.
- **Promoted from the same round** — an audit of the first request found rules stated 2–5 times
  and text pointing at things that do not exist; each rule got one home (commit 1448fcea), and the
  memory section's write-time rules moved behind `memoryFormatGuard.ts` (d41f4d79). The `lean3`
  arm (both together): cost −4.7% (placebo −5.3%), turns equal, 25/25 sessions passing,
  first-turn context 17.7k → 15.8k SEPARATED; memory-write check 12/12 like the baseline. No
  killswitch left; the default renders the measured arm byte for byte.

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
