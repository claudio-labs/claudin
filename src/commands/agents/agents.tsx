import type React from 'react'
import { AgentsMenuWithTabs } from '../../components/agents/AgentsMenuWithTabs.js'
import type { ToolUseContext } from '../../Tool.js'
import { getTools } from '../../tools.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  const appState = context.getAppState()
  const permissionContext = appState.toolPermissionContext
  const tools = getTools(permissionContext)
  return <AgentsMenuWithTabs tools={tools} onExit={onDone} />
}
