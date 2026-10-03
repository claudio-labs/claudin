import type { McpServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { isMcpServerDisabled } from 'src/mcp/config/toggles.js'

export type DedupResult = {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
}

// Paths of the remote-session proxy that wraps a vendor MCP URL in `mcp_url`.
const PROXY_PATH_MARKERS = ['/v2/ccr-sessions/', '/v2/session_ingress/shttp/mcp/']

/** The vendor URL behind a session proxy URL, or the input when there is none. */
export function unwrapCcrProxyUrl(url: string): string {
  if (!PROXY_PATH_MARKERS.some(marker => url.includes(marker)) || !URL.canParse(url)) return url
  return new URL(url).searchParams.get('mcp_url') || url
}

/**
 * What makes two servers the same server: the full command line for stdio,
 * the (unwrapped) URL for anything remote. In-process SDK servers have none.
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  if (config.type === undefined || config.type === 'stdio') {
    return `stdio:${JSON.stringify([config.command, ...(config.args ?? [])])}`
  }
  if ('url' in config) return `url:${unwrapCcrProxyUrl(config.url)}`
  return null
}

function firstOwners(servers: Record<string, ScopedMcpServerConfig>): Map<string, string> {
  const owners = new Map<string, string>()
  for (const [name, config] of Object.entries(servers)) {
    const signature = getMcpServerSignature(config)
    if (signature !== null && !owners.has(signature)) owners.set(signature, name)
  }
  return owners
}

function dropDuplicates(
  candidates: Record<string, ScopedMcpServerConfig>,
  targets: Record<string, ScopedMcpServerConfig>,
  candidatesCompete: boolean,
): DedupResult {
  const owners = firstOwners(targets)
  const result: DedupResult = { servers: {}, suppressed: [] }
  for (const [name, config] of Object.entries(candidates)) {
    const signature = getMcpServerSignature(config)
    const owner = signature === null ? undefined : owners.get(signature)
    if (owner !== undefined) {
      result.suppressed.push({ name, duplicateOf: owner })
      continue
    }
    result.servers[name] = config
    if (candidatesCompete && signature !== null) owners.set(signature, name)
  }
  return result
}

/** Drops plugin servers that a manual server, or an earlier plugin, already provides. */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): DedupResult {
  return dropDuplicates(pluginServers, manualServers, true)
}

/** Drops connectors that an enabled manual server provides; connectors never displace each other. */
export function dedupClaudeAiMcpServers(
  claudeAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): DedupResult {
  const enabledManual = Object.fromEntries(Object.entries(manualServers).filter(([name]) => !isMcpServerDisabled(name)))
  return dropDuplicates(claudeAiServers, enabledManual, false)
}
