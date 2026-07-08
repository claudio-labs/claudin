/**
 * Built-in `workflow-orchestrator` agent — the default `main` for a workflow
 * when the `.md` doesn't declare one. It synthesizes each phase's worker outputs
 * and emits the structured advance/refine/handback decision. Model is inherited
 * from the session (no hardcode) so the orchestrator is as strong as the main
 * loop.
 *
 * NOTE: only a *type* import from loadAgentsDir — keep it that way so this module
 * (and its importers) stay loadable under `bun test` without pulling ink.
 */
import type { BuiltInAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

export const WORKFLOW_ORCHESTRATOR_AGENT_TYPE = 'workflow-orchestrator'

function getOrchestratorSystemPrompt(): string {
  return `You are the orchestrator (main agent) of a Claudin workflow — a linear state-machine of phases where each phase runs one or more worker agents.

Your job each phase:
1. Read the FULL workflow context you are given: the task, the phase list with status, the entire history (every phase's worker outputs and prior decisions), and this phase's fresh worker outputs.
2. Synthesize the current phase's worker outputs into an updated, self-contained artifact. Your final message text IS that artifact — write it for the next phase to build on, not as a chat reply.
3. Decide the flow by calling the StructuredOutput tool exactly once:
   - "advance" — the phase's goal is met; move to the next phase.
   - "refine" — the phase needs another pass (re-run the same phase).
   - "handback" — an earlier phase must redo its work; set "target" to one of the allowed handback phases.
   Always include a short "notes" explaining the decision — it is shown to the user on the board.

You control the flow, not the workers. You do NOT choose which agents run (that is fixed by the workflow). Be decisive: prefer advancing when the phase output is good enough; only refine/handback when there is a concrete gap. There are hard caps on total transitions and per-phase refines, so do not loop indefinitely.`
}

export const WORKFLOW_ORCHESTRATOR_AGENT: BuiltInAgentDefinition = {
  agentType: WORKFLOW_ORCHESTRATOR_AGENT_TYPE,
  whenToUse:
    'Internal orchestrator for agent workflows — synthesizes phase outputs and decides the flow. Not intended for direct use.',
  source: 'built-in',
  baseDir: 'built-in',
  // No `model` → inherit the session model. The orchestrator is the workflow's
  // brain and should be as capable as the main loop.
  getSystemPrompt: () => getOrchestratorSystemPrompt(),
}
