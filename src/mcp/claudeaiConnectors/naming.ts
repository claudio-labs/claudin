import { normalizeNameForMCP } from 'src/mcp/normalization.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

export type ListedConnector = {
  id: string
  display_name: string
  url: string
}

const CONNECTOR_PREFIX = 'claude.ai '

/**
 * Names each connector `claude.ai <display name>`. Tool names are built from
 * the normalized form, so a name that normalizes like one already taken gets
 * ` (2)`, ` (3)`, … until its normalized form is free.
 */
export function nameConnectors(connectors: readonly ListedConnector[]): Record<string, ScopedMcpServerConfig> {
  const taken = new Set<string>()
  const named: Record<string, ScopedMcpServerConfig> = {}
  for (const connector of connectors) {
    const base = CONNECTOR_PREFIX + connector.display_name
    let name = base
    for (let n = 2; taken.has(normalizeNameForMCP(name)); n++) name = `${base} (${n})`
    taken.add(normalizeNameForMCP(name))
    named[name] = { type: 'claudeai-proxy', url: connector.url, id: connector.id, scope: 'claudeai' }
  }
  return named
}
