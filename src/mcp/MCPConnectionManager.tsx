import { c as _c } from "react-compiler-runtime";
import React, { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Command } from 'src/commands/commands.js';
import type { Tool } from 'src/tools/Tool.js';
import type { MCPServerConnection, ScopedMcpServerConfig, ServerResource } from 'src/mcp/types.js';
import { useManageMCPConnections } from 'src/mcp/useManageMCPConnections.js';
interface MCPConnectionContextValue {
  reconnectMcpServer: (serverName: string) => Promise<{
    client: MCPServerConnection;
    tools: Tool[];
    commands: Command[];
    resources?: ServerResource[];
  }>;
  toggleMcpServer: (serverName: string) => Promise<void>;
  disconnectMcpServer: (serverName: string) => Promise<void>;
}
const MCPConnectionContext = createContext<MCPConnectionContextValue | null>(null);
export function useMcpReconnect() {
  const context = useContext(MCPConnectionContext);
  if (!context) {
    throw new Error("useMcpReconnect must be used within MCPConnectionManager");
  }
  return context.reconnectMcpServer;
}
export function useMcpToggleEnabled() {
  const context = useContext(MCPConnectionContext);
  if (!context) {
    throw new Error("useMcpToggleEnabled must be used within MCPConnectionManager");
  }
  return context.toggleMcpServer;
}
export function useMcpDisconnect() {
  const context = useContext(MCPConnectionContext);
  if (!context) {
    throw new Error("useMcpDisconnect must be used within MCPConnectionManager");
  }
  return context.disconnectMcpServer;
}
interface MCPConnectionManagerProps {
  children: ReactNode;
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
}

// TODO (ollie): We may be able to get rid of this context by putting these function on app state
export function MCPConnectionManager(t0: MCPConnectionManagerProps) {
  // React-Compiler output: adding a third value to the context object costs two
  // slots (one more dep, and the shift below), so the count and every index
  // move together. See .claudin/rules/ink-tui.md §6.
  const $ = _c(7);
  const {
    children,
    dynamicMcpConfig,
    isStrictMcpConfig
  } = t0;
  const {
    reconnectMcpServer,
    toggleMcpServer,
    disconnectMcpServer
  } = useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig);
  let t1;
  if ($[0] !== reconnectMcpServer || $[1] !== toggleMcpServer || $[2] !== disconnectMcpServer) {
    t1 = {
      reconnectMcpServer,
      toggleMcpServer,
      disconnectMcpServer
    };
    $[0] = reconnectMcpServer;
    $[1] = toggleMcpServer;
    $[2] = disconnectMcpServer;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const value = t1;
  let t2;
  if ($[4] !== children || $[5] !== value) {
    t2 = <MCPConnectionContext.Provider value={value}>{children}</MCPConnectionContext.Provider>;
    $[4] = children;
    $[5] = value;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}
