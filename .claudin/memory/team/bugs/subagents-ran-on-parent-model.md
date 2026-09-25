---
name: subagents-ran-on-parent-model
description: Every spawned sub-agent ran on the PARENT's model whatever its definition, /agents override or per-call `model` said — the query loop read the parent's app state; FIXED 2026-09-25 (agent/query/turnModel.ts), and WebResearcher/claudin-guide moved haiku→sonnet with it
type: project
paths:
  - "src/agent/query/turnModel.ts"
  - "src/providers/model/agent.ts"
---

**Symptom:** a sub-agent's API calls used the main session's model. Its system
prompt named the model it had been resolved to ("powered by Sonnet 5") while
Opus answered. Found by the Explore E2E on 2026-09-25: an Explore child with the
`sonnet` default and one called with `model: "haiku"` both ran as
`claude-opus-5-5` (sub-agent transcripts). The recorded sessions show the same for
the `haiku`-defined WebResearcher, on `claude-opus-5` and `claude-opus-5-5`.

**Where:** `query.ts` took the turn's model from
`appState.mainLoopModelForSession ?? appState.mainLoopModel ?? …`, and
runAgent's `agentGetAppState` hands a sub-agent its parent's state with the model
untouched. The model runAgent resolved (`getAgentModel`) only reached
`options.mainLoopModel`, which the loop used for token warnings and the prompt
text. It had been like this since the fork's first commit.

**Fix:** `selectTurnModel` — a context spawned by runAgent (the only caller that
sets `agentType`) calls `options.mainLoopModel`. The main thread and the internal
forks (compaction, memory extraction, session memory, suggestions — none sets
`agentType`) keep the app-state path, so their prompt-cache sharing did not move.
An AgentTool fork resolves to the parent's model, as before. The loop's call is
covered by the E2E only; `turnModel.test.ts` pins the decision.

**What changes for a teammate:**
- Sub-agent cost moves on 2026-09-25 — compare across that date knowing it.
  WebResearcher and claudin-guide are `sonnet` now (were `haiku` in the
  definition, ran on the parent), WebResearcherManager and Explore `sonnet`:
  Sonnet on a Claude-native provider, the parent's model elsewhere (user
  decision, 2026-09-25).
- The Agent tool's per-call `model` works, `inherit` included; off a
  Claude-native provider a family alias yields to the agent's configured model,
  then the parent's (`providers/model/agent.ts`).
- /agents overrides and plugin agents' `model:` frontmatter apply for the first
  time.
