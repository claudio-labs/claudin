import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  getAuthVersion,
  onAuthChange,
} from 'src/providers/auth/authChanged.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { useAppState, useAppStateStore } from 'src/terminal/state/AppState.js'
import {
  disconnectServer,
  reconnectServer,
  toggleServer,
} from 'src/mcp/connectionManager/actions.js'
import {
  createConnectionRuntime,
  type ConnectionRuntime,
} from 'src/mcp/connectionManager/runtime.js'
import { startServers } from 'src/mcp/connectionManager/startup.js'
import type { ConnectionActions } from 'src/mcp/connectionManager/types.js'

export { resolveUpdatedTools } from 'src/mcp/connectionManager/poolUpdate.js'

function mountedRuntime(ref: { current: ConnectionRuntime | null }): ConnectionRuntime {
  if (!ref.current) throw new Error('The MCP connection manager is not mounted')
  return ref.current
}

/**
 * Keeps the session's MCP servers in app state: starts them on mount and
 * whenever the inputs change, follows them as they connect, drop and come
 * back, and hands out the user's three actions on them.
 */
export function useManageMCPConnections(
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined,
  isStrictMcpConfig = false,
): ConnectionActions {
  const store = useAppStateStore()
  const pluginReconnectKey = useAppState(state => state.mcp.pluginReconnectKey)
  const authVersion = useSyncExternalStore(onAuthChange, getAuthVersion)
  const sessionId = getSessionId()
  const runtimeRef = useRef<ConnectionRuntime | null>(null)
  const listedForLogin = useRef(authVersion)

  useEffect(() => {
    const runtime = createConnectionRuntime(store)
    runtimeRef.current = runtime
    return () => {
      runtime.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = null
    }
  }, [store])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const loginChanged = listedForLogin.current !== authVersion
    listedForLogin.current = authVersion
    startServers(runtime, { dynamicMcpConfig, isStrictMcpConfig, loginChanged }).catch((error: unknown) =>
      logForDebugging(`MCP start-up failed: ${errorMessage(error)}`, { level: 'error' }),
    )
  }, [store, sessionId, dynamicMcpConfig, isStrictMcpConfig, pluginReconnectKey, authVersion])

  const reconnectMcpServer = useCallback(
    async (serverName: string) => reconnectServer(mountedRuntime(runtimeRef), serverName),
    [],
  )
  const toggleMcpServer = useCallback(
    async (serverName: string) => toggleServer(mountedRuntime(runtimeRef), serverName),
    [],
  )
  const disconnectMcpServer = useCallback(
    async (serverName: string) => disconnectServer(mountedRuntime(runtimeRef), serverName),
    [],
  )

  return { reconnectMcpServer, toggleMcpServer, disconnectMcpServer }
}
