---
name: agent-schema-drops-run-in-background
description: Interactive sessions get an Agent schema without run_in_background and name while the Agent description teaches both; the model sends them as strings, zod strips them, the "background" agent runs inline — found 2026-09-24, not fixed
type: project
paths:
  - "src/tools/AgentTool/AgentTool.tsx"
  - "src/tools/AgentTool/prompt.ts"
---

**Symptom:** asked to spawn a background agent, the model calls
`Agent({…, "run_in_background": "true", "name": "pinger"})` — both as strings —
and the agent runs inline (`ctrl+b ctrl+b to run in background` hint, `Done`
in the same turn). The model then reports it as launched in the background.

**Where:** the tool list sent to the model lacks `run_in_background` and `name`
(a 2026-09-24 interactive session built from 096dbf97 showed only description,
isolation, model, prompt, readOnly, subagent_type), while the description text
(`AgentTool/prompt.ts` — "Pass `run_in_background: true` …", "Give a background
agent a short `name`") teaches both. `AgentTool.inputSchema` is a lazySchema whose
`isRunInBackgroundHidden()` branch is cached at first access; that access
happening before `applyClientType` sets the interactive flag is the suspected
cause — **not verified**.

**Repro:** interactive `claudindev`, prompt "spawn one background agent
(run_in_background: true, name: x) that …"; inspect the session JSONL for the
Agent `input` — `"run_in_background":"true"`.

**Why it matters:** SendMessage `"main"` only works from a background agent
([[cross-session-messaging]]); with this bug the model cannot start one, only
auto-background or `ctrl+b ctrl+b` can. Verified working that way.

**Status 2026-09-24:** left in place — found during the cross-session E2E, out of
that PR's scope. Still present later that day, after the v1.1.35 release
(checkout at 9e93ba9c): an interactive session's Agent schema had the same six
fields. `inputSchema` (`AgentTool.tsx`) omits only `cwd`, plus
`run_in_background` when `isRunInBackgroundHidden()`; `name`, `team_name` and
`mode` sit in `fullInputSchema` yet were missing too, so something else drops
them before the wire — not traced.
