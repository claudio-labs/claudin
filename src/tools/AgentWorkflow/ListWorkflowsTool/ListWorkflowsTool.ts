import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { LIST_WORKFLOWS_TOOL_NAME } from 'src/tools/AgentWorkflow/constants.js'
import { loadWorkflowDefs } from 'src/tools/AgentWorkflow/loadWorkflows.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

type Output = {
  workflows: Array<{
    name: string
    description: string
    phases: Array<{ name: string; agents: string[] }>
    errors?: string[]
  }>
}
const outputSchema = lazySchema(() => z.custom<Output>())
type OutputSchema = ReturnType<typeof outputSchema>

export const ListWorkflowsTool = buildTool({
  name: LIST_WORKFLOWS_TOOL_NAME,
  searchHint: 'list the agent workflows defined in this project',
  maxResultSizeChars: 100_000,
  async description() {
    return 'List the agent workflows defined in this project (.claudin/workflows/*.md), with their phases and per-phase agents.'
  },
  async prompt() {
    return 'List available agent workflows (name, description, phases, and the agents in each phase). Use before calling the Workflow tool to discover what exists.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ListWorkflows'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const { defs, errorsByFile } = await loadWorkflowDefs()
    return {
      data: {
        workflows: defs.map(d => ({
          name: d.name,
          description: d.description,
          phases: d.steps.map(s => ({ name: s.name, agents: s.agents })),
          errors: errorsByFile[d.sourceFile ?? `${d.name}.md`],
        })),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { workflows } = content as Output
    if (workflows.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No workflows defined. Create one at .claudin/workflows/<name>.md',
      }
    }
    const text = workflows
      .map(w => {
        const phases = w.phases
          .map(p => `  - ${p.name}: ${p.agents.join(', ') || '(terminal)'}`)
          .join('\n')
        const err = w.errors?.length ? `\n  ⚠ ${w.errors.join('; ')}` : ''
        return `${w.name} — ${w.description}\n${phases}${err}`
      })
      .join('\n\n')
    return { tool_use_id: toolUseID, type: 'tool_result', content: text }
  },
} satisfies ToolDef<InputSchema, Output>)
