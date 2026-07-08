/** Aggregator for the agent-workflow tools, loaded (via require) from
 * `src/tools.ts` only when `feature('AGENT_WORKFLOWS')` is on. */
import type { Tool } from 'src/Tool.js'
import { ListWorkflowsTool } from './ListWorkflowsTool/ListWorkflowsTool.js'
import { WorkflowStatusTool } from './WorkflowStatusTool/WorkflowStatusTool.js'
import { WorkflowTool } from './WorkflowTool/WorkflowTool.js'

export function getAgentWorkflowTools(): Tool[] {
  return [WorkflowTool, ListWorkflowsTool, WorkflowStatusTool]
}
