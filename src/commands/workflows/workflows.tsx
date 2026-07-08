import type React from 'react'
import { WorkflowsMenuWithTabs } from '../../components/workflows/WorkflowsMenuWithTabs.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <WorkflowsMenuWithTabs context={context} onExit={onDone} />
}
