import type React from 'react'
import { WorkflowsMenuWithTabs } from 'src/components/workflows/WorkflowsMenuWithTabs.js'
import type { ToolUseContext } from 'src/Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from 'src/types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsMenuWithTabs context={context} onExit={onDone} />
}
