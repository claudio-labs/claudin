import { createHash } from 'crypto'
import { join } from 'path'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import type { Command } from 'src/commands/commands.js'
import type { AgentMcpServerInfo } from 'src/mcp/ui/types.js'
import type { Tool } from 'src/tools/Tool.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getGlobalClaudeFile } from 'src/shared/env.js'
import { isSettingSourceEnabled } from 'src/platform/settings/constants.js'
import {
  getInitialSettings,
  hasSkipDangerousModePermissionPrompt,
} from 'src/platform/settings/settings.js'
import { getEnterpriseMcpFilePath } from 'src/mcp/config.js'
import { getMcpPrefix } from 'src/mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from 'src/mcp/normalization.js'
import {
  decideProjectServerStatus,
  type ProjectServerStatus,
} from 'src/mcp/projectServerStatus.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type MCPServerConnection,
  type McpServerConfig,
  type ScopedMcpServerConfig,
  type ServerResource,
} from 'src/mcp/types.js'

// ---------------------------------------------------------------------------
// Which server owns a tool, a command or a resource
// ---------------------------------------------------------------------------

function toolBelongsToServer(tool: Tool, serverName: string): boolean {
  // Tools built outside the registry can arrive without a name.
  const name: string | undefined = tool.name
  return name !== undefined && name.startsWith(getMcpPrefix(serverName))
}

export function filterToolsByServer(tools: Tool[], serverName: string): Tool[] {
  return tools.filter(tool => toolBelongsToServer(tool, serverName))
}

export function excludeToolsByServer(
  tools: Tool[],
  serverName: string,
): Tool[] {
  return tools.filter(tool => !toolBelongsToServer(tool, serverName))
}

/**
 * MCP prompts are `mcp__<server>__…`; MCP skills are `<server>:…`. An empty
 * name can start with neither, so it belongs to no server.
 */
export function commandBelongsToServer(
  command: Command,
  serverName: string,
): boolean {
  const name = command.name
  return (
    name.startsWith(getMcpPrefix(serverName)) ||
    name.startsWith(`${normalizeNameForMCP(serverName)}:`)
  )
}

function isMcpSkill(command: Command): boolean {
  return command.type === 'prompt' && command.loadedFrom === 'mcp'
}

export function filterMcpPromptsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(
    command =>
      commandBelongsToServer(command, serverName) && !isMcpSkill(command),
  )
}

export function excludeCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(command => !commandBelongsToServer(command, serverName))
}

/** Resources are keyed by the server name as configured, never folded. */
export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  return Object.fromEntries(
    Object.entries(resources).filter(([owner]) => owner !== serverName),
  )
}

export function isMcpTool(tool: Tool): boolean {
  const name: string | undefined = tool.name
  return tool.isMcp === true || (name?.startsWith('mcp__') ?? false)
}

// ---------------------------------------------------------------------------
// Reload: the config fingerprint and the servers it makes stale
// ---------------------------------------------------------------------------

/**
 * Plain objects get sorted keys; arrays keep their order. Fields set to
 * undefined vanish when the result is serialized.
 */
function canonicalForm(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalForm)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    canonical[key] = canonicalForm(record[key])
  }
  return canonical
}

/**
 * A fingerprint of what the server is, not where it was configured: a scope
 * change alone must not force a reconnect. Not persisted anywhere.
 */
export function hashMcpConfig(config: ScopedMcpServerConfig): string {
  const { scope: _scope, ...identity } = config
  return createHash('sha256')
    .update(JSON.stringify(canonicalForm(identity)))
    .digest('hex')
    .slice(0, 16)
}

function isStaleClient(
  client: MCPServerConnection,
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  const current = Object.hasOwn(configs, client.name)
    ? configs[client.name]
    : undefined
  // Only a dynamic (plugin) server disappears with its config; the others
  // are handled by their own config watchers.
  if (current === undefined) return client.config.scope === 'dynamic'
  return hashMcpConfig(current) !== hashMcpConfig(client.config)
}

export function excludeStalePluginClients(
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
  },
  configs: Record<string, ScopedMcpServerConfig>,
): {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
  stale: MCPServerConnection[]
} {
  const stale = mcp.clients.filter(client => isStaleClient(client, configs))
  if (stale.length === 0) {
    const { clients, tools, commands, resources } = mcp
    return { clients, tools, commands, resources, stale }
  }

  const goneNames = stale.map(client => client.name)
  const ownedByGone = (owns: (name: string) => boolean): boolean =>
    goneNames.some(owns)
  return {
    clients: mcp.clients.filter(client => !stale.includes(client)),
    tools: mcp.tools.filter(
      tool => !ownedByGone(name => toolBelongsToServer(tool, name)),
    ),
    commands: mcp.commands.filter(
      command => !ownedByGone(name => commandBelongsToServer(command, name)),
    ),
    resources: goneNames.reduce(excludeResourcesByServer, mcp.resources),
    stale,
  }
}

// ---------------------------------------------------------------------------
// Where a scope's servers live, and how it is named
// ---------------------------------------------------------------------------

export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'user':
      return getGlobalClaudeFile()
    case 'project':
      return join(getCwd(), '.mcp.json')
    case 'local':
      return `${getGlobalClaudeFile()} [project: ${getCwd()}]`
    case 'dynamic':
      return 'Dynamically configured'
    case 'enterprise':
      return getEnterpriseMcpFilePath()
    case 'claudeai':
      return 'claude.ai'
    default:
      return scope
  }
}

// `managed` has no label of its own; it reads as the scope word.
const SCOPE_LABELS: Partial<Record<ConfigScope, string>> = {
  local: 'Local config (private to you in this project)',
  project: 'Project config (shared via .mcp.json)',
  user: 'User config (available in all your projects)',
  dynamic: 'Dynamic config (from command line)',
  enterprise: 'Enterprise config (managed by your organization)',
  claudeai: 'claude.ai config',
}

export function getScopeLabel(scope: ConfigScope): string {
  return SCOPE_LABELS[scope] ?? scope
}

// ---------------------------------------------------------------------------
// `mcp add` arguments
// ---------------------------------------------------------------------------

export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'local'
  const known: readonly string[] = ConfigScopeSchema().options
  if (!known.includes(scope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${known.join(', ')}`,
    )
  }
  return scope as ConfigScope
}

const ADDABLE_TRANSPORTS = ['stdio', 'sse', 'http'] as const
type AddableTransport = (typeof ADDABLE_TRANSPORTS)[number]

function isAddableTransport(type: string): type is AddableTransport {
  return (ADDABLE_TRANSPORTS as readonly string[]).includes(type)
}

export function ensureTransport(type?: string): 'stdio' | 'sse' | 'http' {
  if (!type) return 'stdio'
  if (!isAddableTransport(type)) {
    throw new Error(
      `Invalid transport type: ${type}. Must be one of: ${ADDABLE_TRANSPORTS.join(', ')}`,
    )
  }
  return type
}

export function parseHeaders(headerArray: string[]): Record<string, string> {
  // A Map, then fromEntries: a header literally named `__proto__` becomes an
  // own key instead of reaching the prototype.
  const parsed = new Map<string, string>()
  for (const entry of headerArray) {
    const colon = entry.indexOf(':')
    if (colon === -1) {
      throw new Error(
        `Invalid header format: "${entry}". Expected format: "Header-Name: value"`,
      )
    }
    const name = entry.slice(0, colon).trim()
    if (name === '') {
      throw new Error(
        `Invalid header: "${entry}". Header name cannot be empty.`,
      )
    }
    parsed.set(name, entry.slice(colon + 1).trim())
  }
  return Object.fromEntries(parsed)
}

// ---------------------------------------------------------------------------
// Project `.mcp.json` approval
// ---------------------------------------------------------------------------

export function getProjectMcpServerStatus(
  serverName: string,
): ProjectServerStatus {
  const settings = getInitialSettings()
  return decideProjectServerStatus(serverName, {
    enabledNames: settings.enabledMcpjsonServers ?? [],
    disabledNames: settings.disabledMcpjsonServers ?? [],
    enableAll: settings.enableAllProjectMcpServers === true,
    bypassAcceptedOutsideProject: hasSkipDangerousModePermissionPrompt(),
    interactive: !getIsNonInteractiveSession(),
    projectSettingsEnabled: isSettingSourceEnabled('projectSettings'),
  })
}

// ---------------------------------------------------------------------------
// Servers declared inline by agents, as listed in /mcp
// ---------------------------------------------------------------------------

type AgentServerGroup = { config: McpServerConfig; sourceAgents: string[] }

function describeAgentServer(
  name: string,
  { config, sourceAgents }: AgentServerGroup,
): AgentMcpServerInfo | null {
  switch (config.type) {
    case undefined:
    case 'stdio':
      return {
        name,
        sourceAgents,
        transport: 'stdio',
        command: config.command,
        needsAuth: false,
      }
    case 'sse':
    case 'http':
      return {
        name,
        sourceAgents,
        transport: config.type,
        url: config.url,
        needsAuth: true,
      }
    case 'ws':
      return { name, sourceAgents, transport: 'ws', url: config.url, needsAuth: false }
    default:
      return null
  }
}

/**
 * Inline `{ name: config }` entries only; a bare string refers to a server
 * configured elsewhere. The first definition of a name wins.
 */
export function extractAgentMcpServers(
  agents: AgentDefinition[],
): AgentMcpServerInfo[] {
  const groups = new Map<string, AgentServerGroup>()
  for (const agent of agents) {
    for (const spec of agent.mcpServers ?? []) {
      if (typeof spec === 'string') continue
      const inline = Object.entries(spec)
      if (inline.length !== 1) continue
      const [name, config] = inline[0]!
      const group = groups.get(name)
      if (group === undefined) {
        groups.set(name, { config, sourceAgents: [agent.agentType] })
      } else if (!group.sourceAgents.includes(agent.agentType)) {
        group.sourceAgents.push(agent.agentType)
      }
    }
  }
  return [...groups]
    .map(([name, group]) => describeAgentServer(name, group))
    .filter((info): info is AgentMcpServerInfo => info !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// The server URL as it may appear in logs
// ---------------------------------------------------------------------------

/**
 * Drops what can carry a secret: the query string and the `user:password@`
 * credentials. The fragment is kept.
 */
export function getLoggingSafeMcpBaseUrl(
  config: McpServerConfig,
): string | undefined {
  if (!('url' in config)) return undefined
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    return undefined
  }
  url.search = ''
  url.username = ''
  url.password = ''
  const text = url.toString()
  return text.endsWith('/') ? text.slice(0, -1) : text
}
