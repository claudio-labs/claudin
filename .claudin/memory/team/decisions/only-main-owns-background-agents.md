---
name: only-main-owns-background-agents
description: Since 2026-10-15 only the main thread owns background agents — inside a sub-agent run_in_background, auto-background, the 120s timer and Ctrl+B all stay inline; routing the report to the sub-agent was rejected
type: project
scope: tools/AgentTool, agent/tasks
impact: functional
paths:
  - "src/tools/AgentTool/autoBackground.ts"
  - "src/tools/AgentTool/AgentTool.tsx"
  - "src/agent/tasks/LocalAgentTask/**"
---

**Decision:** `ownsBackgroundAgents(callerAgentId)` (`AgentTool/autoBackground.ts`), true only for
main, gates every path that makes an agent async: AgentTool's `shouldRunAsync` and
`implicitBackgroundAllowed` (auto-background and the 120 s timer), and `backgroundAgentTask`
(Ctrl+B, keyed on the task's `parentAgentId`). Inside a sub-agent the spawn runs inline and
returns its report in the call — silently, as `-p` ignores the field.

**Why:** a background agent launched by a sub-agent enqueued its `<task-notification>` with no
`agentId`, so main drained it (`query.ts` drain filter) and the sub-agent, told it would be
notified, never heard back. A sub-agent cannot idle for a notice — ending its turn ends its task
(`awaitReply.ts` header) — so routing helps only while it still makes tool rounds, and once it
returns the report must go to its parent anyway. Found by the 2026-10-15 census review, not by a
census count.

**What changes for a teammate:**
- A new way to make an agent async (flag, timer, UI action) must check `ownsBackgroundAgents`;
  `scripts/migrations/probes/subagentBackgroundInline.json` breaks the three existing gates.
- Parallel work inside a sub-agent is several inline Agent calls in one message (Agent is
  concurrency-safe), not background agents.
- `run_in_background` stays in the sub-agent's schema on purpose: the Agent schema and description
  are cached per tool name per session (`api.ts` toolSchemaCache), so hiding it per agent would
  move the prefix.
- Still reporting to main: an agent a sub-agent RESUMES via SendMessage (documented in
  `docs/tech/agent-messaging/README.md`; `await_reply` returns its end).

**Rejected:**
- Routing the notice to the launcher (`agentId: parentAgentId`) with a handoff up the chain when it
  exits: `killShellTasksForAgent` purges every command addressed to an exiting agent (it would eat
  the report), the handoff is needed at four task transitions, and a report enqueued between
  runAgent's `finally` and `unregisterAgentForeground` would be stranded. All to cover the window in
  which the sub-agent is still working.
- A "ran inline" line in the sub-agent's result: parity with `-p`, no outputSchema change.

**Evidence:** branch `fix/subagent-background-inline` (2026-10-15, plan
`.claudin/plans/tender-splashing-phoenix.md`). Live under tmux: a Code sub-agent's
`run_in_background: true` came back inline (`first line: kiwi-42`) and main got no notice; main's
own background agent still notified ([[tool-error-census-2026-10-15]]).
