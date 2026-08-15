/** Tool names for the agent-workflow feature (AGENT_WORKFLOWS). Kept in a
 * dependency-light module so `src/tools/constants/tools.ts` can reference them without
 * importing the tool implementations. Distinct from the upstream `WorkflowTool`
 * (WORKFLOW_SCRIPTS) stub. */
export const WORKFLOW_RUN_TOOL_NAME = 'Workflow'
export const LIST_WORKFLOWS_TOOL_NAME = 'ListWorkflows'
export const WORKFLOW_STATUS_TOOL_NAME = 'WorkflowStatus'
