import type React from 'react'
import { AgentsMenuWithTabs } from 'src/components/agents/AgentsMenuWithTabs.js'
import type { ToolUseContext } from 'src/Tool.js'
import { getTools } from 'src/tools.js'
import type { LocalJSXCommandOnDone } from 'src/types/command.js'

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  const appState = context.getAppState()
  const permissionContext = appState.toolPermissionContext
  const tools = getTools(permissionContext)
  return <AgentsMenuWithTabs tools={tools} onExit={onDone} />
}
