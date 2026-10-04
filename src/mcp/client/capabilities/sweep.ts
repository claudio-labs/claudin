import type { Command } from 'src/commands/commands.js'
import { type Tool, toolMatchesName } from 'src/tools/Tool.js'
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { createMcpAuthTool } from 'src/tools/McpAuthTool/McpAuthTool.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from 'src/mcp/types.js'

/** What the sweep, or a reconnect, reports for one server. */
export type ServerOutcome = {
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}

/** How the sweep treats a configured server before contacting it. */
export type SweepPlan = 'disabled' | 'needs-auth' | 'connect'

/** What `classifyServer` needs to know, gathered by the caller. */
export type ServerFacts = {
  disabled: boolean
  /** The server answered "log in first" recently (the needs-auth cache). */
  needsAuthCached: boolean
  /** OAuth discovery ran for it before, yet no token was ever stored. */
  probedWithoutToken: boolean
}

/** Servers whose OAuth state is kept per server, so a past probe can be read back. */
export function isOAuthProbed(
  config: ScopedMcpServerConfig,
): config is ScopedMcpServerConfig & (McpHTTPServerConfig | McpSSEServerConfig) {
  return config.type === 'http' || config.type === 'sse'
}

function canAskForLogin(config: ScopedMcpServerConfig): boolean {
  return isOAuthProbed(config) || config.type === 'claudeai-proxy'
}

/** Disabled wins; a remote server that asked for a login is left alone until it is cleared. */
export function classifyServer(config: ScopedMcpServerConfig, facts: ServerFacts): SweepPlan {
  if (facts.disabled) return 'disabled'
  if (canAskForLogin(config) && facts.needsAuthCached) return 'needs-auth'
  if (isOAuthProbed(config) && facts.probedWithoutToken) return 'needs-auth'
  return 'connect'
}

export function disabledOutcome(name: string, config: ScopedMcpServerConfig): ServerOutcome {
  return { client: { name, type: 'disabled', config }, tools: [], commands: [] }
}

/** A server waiting for a login offers one tool: the one that starts the login. */
export function needsAuthOutcome(client: MCPServerConnection): ServerOutcome {
  return { client, tools: [createMcpAuthTool(client.name, client.config)], commands: [] }
}

export function failedOutcome(name: string, config: ScopedMcpServerConfig): ServerOutcome {
  return { client: { name, type: 'failed', config }, tools: [], commands: [] }
}

/** The resource tools, minus any the server already offers under those names. */
export function resourceToolsMissingFrom(tools: readonly Tool[]): Tool[] {
  const resourceTools: Tool[] = [ListMcpResourcesTool, ReadMcpResourceTool]
  return resourceTools.filter(candidate => !tools.some(own => toolMatchesName(own, candidate.name)))
}
