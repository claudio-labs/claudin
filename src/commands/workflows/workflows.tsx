import type React from 'react'
import { WorkflowsMenuWithTabs } from 'src/agent/ui/workflows/WorkflowsMenuWithTabs.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from 'src/types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsMenuWithTabs context={context} onExit={onDone} />
}
