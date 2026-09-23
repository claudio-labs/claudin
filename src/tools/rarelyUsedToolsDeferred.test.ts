import { expect, test } from 'bun:test'
import { ListWorkflowsTool } from 'src/tools/AgentWorkflow/ListWorkflowsTool/ListWorkflowsTool.js'
import { WorkflowStatusTool } from 'src/tools/AgentWorkflow/WorkflowStatusTool/WorkflowStatusTool.js'
import { WorkflowTool } from 'src/tools/AgentWorkflow/WorkflowTool/WorkflowTool.js'
import { RenameTool } from 'src/tools/RenameTool/RenameTool.js'
import { isDeferredTool } from 'src/tools/ToolSearchTool/prompt.js'

// Every request carries the eager tools' schemas; these four were called 4
// times in 155 sessions (2026-09-09..23), so they wait behind a ToolSearch.
// Their searchHint is what that search matches on.
test.each([
  ['Workflow', WorkflowTool],
  ['WorkflowStatus', WorkflowStatusTool],
  ['ListWorkflows', ListWorkflowsTool],
  ['Rename', RenameTool],
] as const)('%s is deferred and findable', (_name, tool) => {
  expect(isDeferredTool(tool)).toBe(true)
  expect(tool.searchHint?.length ?? 0).toBeGreaterThan(0)
})
