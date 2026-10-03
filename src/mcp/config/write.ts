import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import { errorMessage } from 'src/shared/errors.js'
import { type ConfigScope, type McpServerConfig, McpServerConfigSchema } from 'src/mcp/types.js'
import { judgeAgainstSettings } from 'src/mcp/config/policySettings.js'
import { loadProjectFile, projectFilePath, saveProjectFile } from 'src/mcp/config/projectFile.js'
import { doesEnterpriseMcpConfigExist } from 'src/mcp/config/scopes.js'

const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const TRANSPORT_TYPES = 'stdio (the default), sse, http, ws, sse-ide, ws-ide, sdk, claudeai-proxy'

type ServerMap = Record<string, McpServerConfig>

/** The two scopes kept in the global config, and how their messages name them. */
type StoredScope = {
  addedTo: string
  removedLabel: string
  read: () => ServerMap | undefined
  update: (edit: (servers: ServerMap) => ServerMap) => void
}

const STORED_SCOPES: Record<'user' | 'local', StoredScope> = {
  user: {
    addedTo: 'user config',
    removedLabel: 'user-scoped MCP server',
    read: () => getGlobalConfig().mcpServers,
    update: edit => saveGlobalConfig(config => ({ ...config, mcpServers: edit(config.mcpServers ?? {}) })),
  },
  local: {
    addedTo: 'local config',
    removedLabel: 'project-local MCP server',
    read: () => getCurrentProjectConfig().mcpServers,
    update: edit => saveCurrentProjectConfig(project => ({ ...project, mcpServers: edit(project.mcpServers ?? {}) })),
  },
}

function without<T>(record: Record<string, T>, name: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))
}

type SchemaIssue = { code: string; path: readonly PropertyKey[]; message: string }

function describeIssue(issue: SchemaIssue): string {
  const text =
    issue.code === 'invalid_union'
      ? `${issue.message}: matches no MCP transport (accepted types: ${TRANSPORT_TYPES})`
      : issue.message
  return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${text}` : text
}

function assertNameAllowed(name: string): void {
  if (name.length === 0) throw new Error('Invalid name: a server name cannot be empty.')
  if (!SERVER_NAME.test(name)) {
    throw new Error(`Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`)
  }
}

function validated(config: unknown): McpServerConfig {
  const checked = McpServerConfigSchema().safeParse(config)
  if (!checked.success) throw new Error(`Invalid configuration: ${checked.error.issues.map(describeIssue).join(', ')}`)
  return checked.data
}

/** The policy as the merge applies it: an SDK server gets no exemption here. */
function assertPolicyAdmits(name: string, server: McpServerConfig): void {
  switch (judgeAgainstSettings(name, server)) {
    case 'denied':
      throw new Error(`Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`)
    case 'not-allowed':
      throw new Error(`Cannot add MCP server "${name}": not allowed by enterprise policy`)
    case 'allowed':
      return
  }
}

async function addToProjectFile(name: string, server: McpServerConfig): Promise<void> {
  const path = projectFilePath()
  const state = loadProjectFile(path)
  if (state.kind === 'broken') {
    throw new Error(`Cannot add MCP server ${name}: .mcp.json is unusable (${state.problem}). Fix it first; it was left unchanged.`)
  }
  if (Object.hasOwn(state.servers, name)) throw new Error(`MCP server ${name} already exists in .mcp.json`)
  try {
    await saveProjectFile(path, state.document, { ...state.servers, [name]: server })
  } catch (error) {
    throw new Error(`Failed to write to .mcp.json: ${errorMessage(error)}`)
  }
}

async function removeFromProjectFile(name: string): Promise<void> {
  const path = projectFilePath()
  const state = loadProjectFile(path)
  // A file that cannot be used holds no server we could remove.
  if (state.kind === 'broken' || !Object.hasOwn(state.servers, name)) {
    throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
  }
  try {
    await saveProjectFile(path, state.document, without(state.servers, name))
  } catch (error) {
    throw new Error(`Failed to remove from .mcp.json: ${errorMessage(error)}`)
  }
}

function addToStored(scope: StoredScope, name: string, server: McpServerConfig): void {
  if (Object.hasOwn(scope.read() ?? {}, name)) throw new Error(`MCP server ${name} already exists in ${scope.addedTo}`)
  scope.update(servers => ({ ...servers, [name]: server }))
}

function removeFromStored(scope: StoredScope, name: string): void {
  if (!Object.hasOwn(scope.read() ?? {}, name)) throw new Error(`No ${scope.removedLabel} found with name: ${name}`)
  scope.update(servers => without(servers, name))
}

/**
 * Checks run in a fixed order and the first failure wins: the name, the
 * managed file's lock, the schema, the policy, then the target scope.
 */
export async function addMcpConfig(name: string, config: unknown, scope: ConfigScope): Promise<void> {
  assertNameAllowed(name)
  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      'Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers',
    )
  }
  const server = validated(config)
  assertPolicyAdmits(name, server)
  switch (scope) {
    case 'project':
      return addToProjectFile(name, server)
    case 'user':
    case 'local':
      return addToStored(STORED_SCOPES[scope], name, server)
    default:
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
}

export async function removeMcpConfig(name: string, scope: ConfigScope): Promise<void> {
  switch (scope) {
    case 'project':
      return removeFromProjectFile(name)
    case 'user':
    case 'local':
      return removeFromStored(STORED_SCOPES[scope], name)
    default:
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
}
