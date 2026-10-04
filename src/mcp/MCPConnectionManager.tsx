import React, { createContext, type ReactNode, useContext, useMemo } from 'react'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { ConnectionActions } from 'src/mcp/connectionManager/types.js'
import { useManageMCPConnections } from 'src/mcp/useManageMCPConnections.js'

const ConnectionActionsContext = createContext<ConnectionActions | null>(null)

function useConnectionActions(hookName: string): ConnectionActions {
  const actions = useContext(ConnectionActionsContext)
  if (!actions) throw new Error(`${hookName} must be used within MCPConnectionManager`)
  return actions
}

export function useMcpReconnect(): ConnectionActions['reconnectMcpServer'] {
  return useConnectionActions('useMcpReconnect').reconnectMcpServer
}

export function useMcpToggleEnabled(): ConnectionActions['toggleMcpServer'] {
  return useConnectionActions('useMcpToggleEnabled').toggleMcpServer
}

export function useMcpDisconnect(): ConnectionActions['disconnectMcpServer'] {
  return useConnectionActions('useMcpDisconnect').disconnectMcpServer
}

interface MCPConnectionManagerProps {
  children: ReactNode;
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
}

export function MCPConnectionManager({
  children,
  dynamicMcpConfig,
  isStrictMcpConfig,
}: MCPConnectionManagerProps): React.ReactNode {
  const { reconnectMcpServer, toggleMcpServer, disconnectMcpServer } = useManageMCPConnections(
    dynamicMcpConfig,
    isStrictMcpConfig,
  )
  const actions = useMemo(
    () => ({ reconnectMcpServer, toggleMcpServer, disconnectMcpServer }),
    [reconnectMcpServer, toggleMcpServer, disconnectMcpServer],
  )
  return <ConnectionActionsContext.Provider value={actions}>{children}</ConnectionActionsContext.Provider>
}
