---
name: agent-schema-drops-run-in-background
description: Interactive sessions got an Agent schema without run_in_background and name, so every "background" agent ran inline — found 2026-09-24, FIXED 2026-09-26 on feat/agents-ask-each-other (wire schema trimmed per request)
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

**Root cause, traced 2026-09-26 (main 5b197ef4, still unfixed) — two causes:**
- `run_in_background`: `AgentTool.tsx` is imported by `main.tsx`'s static graph
  before `main()` runs `applyClientType` (`main.tsx:169`); `buildTool`'s
  `{...TOOL_DEFAULTS, ...def}` spread (`Tool.ts:974`) evaluates the
  `inputSchema` getter right then, while `STATE.isInteractive` is still false,
  so `isRunInBackgroundHidden()` (`AgentTool.tsx:138`) freezes the omit. The
  lazySchema cache is not the cause; the spread would freeze it anyway.
- `name`/`team_name`/`mode`: `SWARM_FIELDS_BY_TOOL` (`providers/transport/api.ts:70`)
  strips them whenever agent teams are off (the default). `name` is no longer
  swarm-only — it keys the `agentNameRegistry` SendMessage resolves.
- Census 09-24..26: 25/25 Agent calls sent `"run_in_background":"true"` as a
  string; none ran in the background. Fix sketch: keep the field in zod, strip
  it in `toolToAPISchema` at request time; drop `name` from the swarm filter.

**FIXED 2026-09-26** (`cbc52195`, branch `feat/agents-ask-each-other`): the zod
schema is fixed and `hiddenSchemaFields` (`providers/transport/api.ts`) drops
`run_in_background` and `name` per request only under `isRunInBackgroundHidden()`
(`name` stays inside an agent team); `call()` ignores a withheld
`run_in_background`. `agentSchema.wire.test.ts` loads `main.tsx` in the real
startup order and asserts both fields. Verified live: the E2E's main sent
`run_in_background: true` as a boolean and both agents ran in the background.
