/** Aggregator for the agent-workflow tools, loaded (via require) from
 * `src/tools/tools.ts` only when `feature('AGENT_WORKFLOWS')` is on. */
import type { Tool } from 'src/tools/Tool.js'
import { ListWorkflowsTool } from 'src/tools/AgentWorkflow/ListWorkflowsTool/ListWorkflowsTool.js'
import { WorkflowStatusTool } from 'src/tools/AgentWorkflow/WorkflowStatusTool/WorkflowStatusTool.js'
import { WorkflowTool } from 'src/tools/AgentWorkflow/WorkflowTool/WorkflowTool.js'

export function getAgentWorkflowTools(): Tool[] {
  return [WorkflowTool, ListWorkflowsTool, WorkflowStatusTool]
}
