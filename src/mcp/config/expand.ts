import { expandEnvVarsInString } from 'src/mcp/envExpansion.js'
import type { McpServerConfig } from 'src/mcp/types.js'

export type ServerExpansion = {
  server: McpServerConfig
  /** Each unset name once, in the order it was first met. */
  missing: string[]
}

/**
 * Fills placeholders in the fields that launch or reach a server: a stdio
 * command, its args and env values; a remote url and its header values.
 * Keys, `headersHelper`, `oauth` and the internal transports stay as written.
 */
export function expandServerPlaceholders(server: McpServerConfig): ServerExpansion {
  const unset: string[] = []
  const fill = (text: string): string => {
    const { expanded, missingVars } = expandEnvVarsInString(text)
    unset.push(...missingVars)
    return expanded
  }
  const fillValues = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([key, text]) => [key, fill(text)]))

  let expanded: McpServerConfig = server
  switch (server.type) {
    case undefined:
    case 'stdio': {
      const command = fill(server.command)
      const args = server.args.map(fill)
      expanded = server.env ? { ...server, command, args, env: fillValues(server.env) } : { ...server, command, args }
      break
    }
    case 'sse':
    case 'http':
    case 'ws': {
      const url = fill(server.url)
      expanded = server.headers ? { ...server, url, headers: fillValues(server.headers) } : { ...server, url }
      break
    }
  }
  return { server: expanded, missing: [...new Set(unset)] }
}
