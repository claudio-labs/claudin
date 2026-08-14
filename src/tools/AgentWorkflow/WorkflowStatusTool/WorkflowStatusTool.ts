import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { WORKFLOW_STATUS_TOOL_NAME } from 'src/tools/AgentWorkflow/constants.js'
import { readRun } from 'src/tools/AgentWorkflow/runStore.js'
import type { RunStatus } from 'src/tools/AgentWorkflow/types.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    runId: z.string().describe('The workflow run id (from the Workflow tool or /workflows).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output =
  | { found: false; runId: string }
  | {
      found: true
      runId: string
      workflow: string
      status: RunStatus
      currentStep: string
      totalTokens: number
      phases: Array<{ step: string; agents: number; decision: string | null }>
    }
const outputSchema = lazySchema(() => z.custom<Output>())
type OutputSchema = ReturnType<typeof outputSchema>

export const WorkflowStatusTool = buildTool({
  name: WORKFLOW_STATUS_TOOL_NAME,
  searchHint: 'inspect a workflow run by id',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Inspect a workflow run by id: its status, current phase, per-phase decisions, and token usage. Useful for background runs.'
  },
  async prompt() {
    return 'Inspect a workflow run by runId (current phase, status, per-phase decisions, tokens). Use to check on a background Workflow run.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'WorkflowStatus'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.runId
  },
  renderToolUseMessage(input) {
    return input.runId
  },
  async call({ runId }) {
    const run = await readRun(runId)
    if (!run) return { data: { found: false, runId } satisfies Output }
    return {
      data: {
        found: true,
        runId: run.runId,
        workflow: run.workflow,
        status: run.status,
        currentStep: run.currentStep,
        totalTokens: run.totalTokens,
        phases: run.history.map(h => ({
          step: h.step,
          agents: h.agents.filter(a => a.label !== 'main').length,
          decision: h.decision ? `${h.decision.decision}${h.decision.target ? `→${h.decision.target}` : ''}` : null,
        })),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as Output
    if (!out.found) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: `No workflow run "${out.runId}".` }
    }
    const phases = out.phases
      .map(p => `- ${p.step} (${p.agents} agents)${p.decision ? ` → ${p.decision}` : ''}`)
      .join('\n')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Workflow "${out.workflow}" run ${out.runId}: ${out.status} · at "${out.currentStep}" · ${out.totalTokens.toLocaleString()} tokens\n${phases}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
