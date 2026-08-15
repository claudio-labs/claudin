import type React from 'react'
import { AgentsMenuWithTabs } from 'src/agent/ui/agents/AgentsMenuWithTabs.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { getTools } from 'src/tools/tools.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  const appState = context.getAppState()
  const permissionContext = appState.toolPermissionContext
  const tools = getTools(permissionContext)
  return <AgentsMenuWithTabs tools={tools} onExit={onDone} />
}
