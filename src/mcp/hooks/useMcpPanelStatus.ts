// Folds the session's MCP connection state into AppState.tasks, where the
// footer's `mcp` group renders it.
//
// The container panel's twin (`src/containers/hooks/useContainerStatus.ts`),
// minus everything that made that one expensive: there is no watcher, no
// subprocess and no idle timer here, because `AppState.mcp` is already
// maintained by `useManageMCPConnections` and changes only when a connection
// actually transitions. This hook is a fold, not a source.
//
// Killswitch: CLAUDIN_DISABLE_MCP_PANEL=1 stops the fold and, with no rows ever
// registered, removes the footer group with it.

import { useEffect } from 'react'
import { useAppState, useAppStateStore } from 'src/terminal/state/AppState.js'
import { applyMcpSnapshot } from 'src/agent/tasks/McpServerTask/applySnapshot.js'

export function isMcpPanelDisabled(): boolean {
  return process.env.CLAUDIN_DISABLE_MCP_PANEL === '1'
}

/**
 * Mount once, from the footer. Renders nothing and returns nothing: the rows
 * live in `AppState.tasks` like every other background task, so the tree, the
 * cursor and the `x` key work without this hook being in the picture.
 */
export function useMcpPanelStatus(enabled = true): void {
  const store = useAppStateStore()
  const clients = useAppState(s => s.mcp.clients)
  const tools = useAppState(s => s.mcp.tools)
  const resources = useAppState(s => s.mcp.resources)

  useEffect(() => {
    if (!enabled) return
    if (isMcpPanelDisabled()) return
    // Writes `tasks`, reads `mcp` — so this effect never re-triggers itself,
    // and a snapshot that changes nothing writes nothing at all.
    applyMcpSnapshot(store.getState, store.setState, clients, tools, resources)
  }, [enabled, store, clients, tools, resources])
}
