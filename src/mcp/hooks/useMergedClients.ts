import { useMemo } from 'react'
import type { MCPServerConnection } from 'src/mcp/types.js'

/**
 * The clients the REPL started with, then the ones app state keeps, one per
 * name: the first occurrence wins. With nothing to add, the initial array
 * itself comes back, so its identity holds.
 */
export function mergeClients(
  initialClients: MCPServerConnection[] | undefined,
  mcpClients: readonly MCPServerConnection[] | undefined,
): MCPServerConnection[] {
  if (!mcpClients || mcpClients.length === 0) return initialClients ?? []
  const seen = new Set<string>()
  const merged: MCPServerConnection[] = []
  for (const client of [...(initialClients ?? []), ...mcpClients]) {
    if (seen.has(client.name)) continue
    seen.add(client.name)
    merged.push(client)
  }
  return merged
}

export function useMergedClients(
  initialClients: MCPServerConnection[] | undefined,
  mcpClients: MCPServerConnection[] | undefined,
): MCPServerConnection[] {
  return useMemo(() => mergeClients(initialClients, mcpClients), [initialClients, mcpClients])
}
