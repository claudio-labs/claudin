import {
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import pMap from 'p-map'
import type { Command } from 'src/commands/commands.js'
import type { Tool } from 'src/tools/Tool.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError, logMCPDebug, logMCPError } from 'src/shared/log.js'
import { memoizeWithLRU } from 'src/shared/data/memoize.js'
import { recursivelySanitizeUnicode } from 'src/shared/data/sanitization.js'
import { clearKeychainCache } from 'src/platform/secureStorage/macOsKeychainHelpers.js'
import { hasMcpDiscoveryButNoToken } from 'src/mcp/auth.js'
import { markClaudeAiMcpConnected } from 'src/mcp/claudeai.js'
import { getAllMcpConfigs, isMcpServerDisabled } from 'src/mcp/config.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from 'src/mcp/types.js'
import { isMcpAuthCached } from 'src/mcp/client/authCache.js'
// connection.js imports this module back; its bindings are only read inside
// function bodies, so the cycle resolves once both modules have loaded.
import {
  clearServerCache,
  connectToServer,
  isIncludedMcpTool,
  isLocalMcpServer,
} from 'src/mcp/client/connection.js'
import {
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
} from 'src/mcp/client/fetch.js'
import { commandFromPrompt, resourceFromListing } from 'src/mcp/client/capabilities/promptCommand.js'
import { TOOL_LIST_ATTEMPTS, TOOL_LIST_RETRY_DELAYS_MS, withRetries } from 'src/mcp/client/capabilities/retry.js'
import {
  classifyServer,
  disabledOutcome,
  failedOutcome,
  isOAuthProbed,
  needsAuthOutcome,
  resourceToolsMissingFrom,
  type ServerFacts,
  type ServerOutcome,
} from 'src/mcp/client/capabilities/sweep.js'
import { toolFromListing } from 'src/mcp/client/capabilities/toolFromListing.js'

export { mcpToolInputToAutoClassifierInput } from 'src/mcp/client/capabilities/toolFromListing.js'

/** Distinct server names whose lists are kept at once. */
const LISTS_KEPT = 20

const byServerName = (record: MCPServerConnection): string => record.name

function connectedWith(record: MCPServerConnection, capability: 'tools' | 'resources' | 'prompts'): ConnectedMCPServer | null {
  return record.type === 'connected' && record.capabilities?.[capability] ? record : null
}

function offersBareNames(server: ConnectedMCPServer): boolean {
  return server.config.type === 'sdk' && isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)
}

async function listTools(server: ConnectedMCPServer): Promise<Tool[]> {
  const answer = await withRetries(
    () => server.client.request({ method: 'tools/list' }, ListToolsResultSchema),
    TOOL_LIST_ATTEMPTS,
    TOOL_LIST_RETRY_DELAYS_MS,
    {
      onRetry: (attempt, error) =>
        logMCPDebug(server.name, `tools/list attempt ${attempt} failed, retrying: ${errorMessage(error)}`),
    },
  )
  const options = { bareName: offersBareNames(server) }
  return recursivelySanitizeUnicode(answer.tools)
    .map(listed => toolFromListing(server, listed, options))
    .filter(isIncludedMcpTool)
}

export const fetchToolsForClient = memoizeWithLRU(
  async (record: MCPServerConnection): Promise<Tool[]> => {
    const server = connectedWith(record, 'tools')
    if (!server) return []
    try {
      return await listTools(server)
    } catch (error) {
      logMCPError(record.name, error)
      return []
    }
  },
  byServerName,
  LISTS_KEPT,
)

export const fetchResourcesForClient = memoizeWithLRU(
  async (record: MCPServerConnection): Promise<ServerResource[]> => {
    const server = connectedWith(record, 'resources')
    if (!server) return []
    try {
      const answer = await server.client.request({ method: 'resources/list' }, ListResourcesResultSchema)
      return recursivelySanitizeUnicode(answer.resources).map(resource => resourceFromListing(server.name, resource))
    } catch (error) {
      logMCPError(record.name, error)
      return []
    }
  },
  byServerName,
  LISTS_KEPT,
)

export const fetchCommandsForClient = memoizeWithLRU(
  async (record: MCPServerConnection): Promise<Command[]> => {
    const server = connectedWith(record, 'prompts')
    if (!server) return []
    try {
      const answer = await server.client.request({ method: 'prompts/list' }, ListPromptsResultSchema)
      return recursivelySanitizeUnicode(answer.prompts).map(prompt => commandFromPrompt(server, prompt))
    } catch (error) {
      logMCPError(record.name, error)
      return []
    }
  },
  byServerName,
  LISTS_KEPT,
)

/**
 * Everything a connected server offers. `claimResourceTools` is asked only
 * when the server lists resources, and says whether this server is the one
 * that carries the shared resource tools.
 */
async function connectedOutcome(
  server: ConnectedMCPServer,
  claimResourceTools: () => boolean,
): Promise<ServerOutcome> {
  if (server.config.type === 'claudeai-proxy') markClaudeAiMcpConnected(server.name)
  const listsResources = Boolean(server.capabilities?.resources)
  const [tools, commands, resources] = await Promise.all([
    fetchToolsForClient(server),
    fetchCommandsForClient(server),
    listsResources ? fetchResourcesForClient(server) : Promise.resolve([]),
  ])
  const shared = listsResources && claimResourceTools() ? resourceToolsMissingFrom(tools) : []
  const outcome: ServerOutcome = { client: server, tools: [...tools, ...shared], commands }
  if (resources.length > 0) outcome.resources = resources
  return outcome
}

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}> {
  try {
    clearKeychainCache()
    await clearServerCache(name, config)
    const client = await connectToServer(name, config)
    if (client.type !== 'connected') return { client, tools: [], commands: [] }
    return await connectedOutcome(client, () => true)
  } catch (error) {
    logMCPError(name, error)
    return failedOutcome(name, config)
  }
}

async function gatherFacts(name: string, config: ScopedMcpServerConfig): Promise<ServerFacts> {
  if (isMcpServerDisabled(name)) return { disabled: true, needsAuthCached: false, probedWithoutToken: false }
  return {
    disabled: false,
    needsAuthCached: await isMcpAuthCached(name),
    probedWithoutToken: isOAuthProbed(config) && hasMcpDiscoveryButNoToken(name, config),
  }
}

async function sweepServer(
  name: string,
  config: ScopedMcpServerConfig,
  claimResourceTools: () => boolean,
): Promise<ServerOutcome> {
  try {
    const plan = classifyServer(config, await gatherFacts(name, config))
    if (plan === 'disabled') return disabledOutcome(name, config)
    if (plan === 'needs-auth') return needsAuthOutcome({ name, type: 'needs-auth', config })
    const client = await connectToServer(name, config)
    if (client.type === 'connected') return await connectedOutcome(client, claimResourceTools)
    if (client.type === 'needs-auth') return needsAuthOutcome(client)
    return { client, tools: [], commands: [] }
  } catch (error) {
    logMCPError(name, error)
    return failedOutcome(name, config)
  }
}

export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt: (params: {
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }) => void,
  mcpConfigs?: Record<string, ScopedMcpServerConfig>,
): Promise<void> {
  const configs = mcpConfigs ?? (await getAllMcpConfigs()).servers
  let resourceToolsGiven = false
  const claimResourceTools = (): boolean => {
    if (resourceToolsGiven) return false
    resourceToolsGiven = true
    return true
  }
  const visit = async ([name, config]: [string, ScopedMcpServerConfig]): Promise<void> => {
    onConnectionAttempt(await sweepServer(name, config, claimResourceTools))
  }

  const entries = Object.entries(configs)
  const local = entries.filter(([, config]) => isLocalMcpServer(config))
  const remote = entries.filter(([, config]) => !isLocalMcpServer(config))
  await Promise.all([
    pMap(local, visit, { concurrency: getMcpServerConnectionBatchSize() }),
    pMap(remote, visit, { concurrency: getRemoteMcpServerConnectionBatchSize() }),
  ])
}

export async function prefetchAllMcpResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
}> {
  const gathered = { clients: [] as MCPServerConnection[], tools: [] as Tool[], commands: [] as Command[] }
  if (Object.keys(mcpConfigs).length === 0) return gathered
  try {
    await getMcpToolsCommandsAndResources(({ client, tools, commands }) => {
      gathered.clients.push(client)
      gathered.tools.push(...tools)
      gathered.commands.push(...commands)
    }, mcpConfigs)
    return gathered
  } catch (error) {
    logError(error)
    return { clients: [], tools: [], commands: [] }
  }
}
