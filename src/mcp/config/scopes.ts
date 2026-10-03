import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { getCurrentProjectConfig, getGlobalConfig } from 'src/platform/config/config.js'
import { isSettingSourceEnabled, type SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { isRestrictedToPluginOnly } from 'src/platform/settings/pluginOnlyPolicy.js'
import type { ValidationError } from 'src/platform/settings/validation.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { readMcpFile } from 'src/mcp/config/jsonFile.js'
import { type McpParseResult, parseMcpConfig, parseMcpConfigFromFilePath, parseMcpFileRead } from 'src/mcp/config/parse.js'

export type ScopeRead = {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
}

export type ReadableScope = 'project' | 'user' | 'local' | 'enterprise'

const PROJECT_FILE = '.mcp.json'
const MANAGED_FILE = 'managed-mcp.json'

/** The `--setting-sources` entry that switches each user-editable scope on. */
const GATING_SOURCE: Record<Exclude<ReadableScope, 'enterprise'>, SettingSource> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

function nothing(): ScopeRead {
  return { servers: {}, errors: [] }
}

function tagged(servers: Record<string, McpServerConfig>, scope: ConfigScope): Record<string, ScopedMcpServerConfig> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { ...server, scope }]))
}

function toScopeRead(result: McpParseResult, scope: ConfigScope): ScopeRead {
  return { servers: result.config ? tagged(result.config.mcpServers, scope) : {}, errors: result.errors }
}

/** Reads one MCP JSON file for a scope; a file that is not there is no error. */
function readOptionalFile(filePath: string, scope: ConfigScope): ScopeRead {
  const read = readMcpFile(filePath)
  if (read.kind === 'missing') return nothing()
  return toScopeRead(parseMcpFileRead(read, { filePath, expandVars: true, scope }), scope)
}

function readStored(servers: Record<string, McpServerConfig> | undefined, scope: 'user' | 'local'): ScopeRead {
  if (!servers) return nothing()
  return toScopeRead(parseMcpConfig({ configObject: { mcpServers: servers }, expandVars: true, scope }), scope)
}

/**
 * `start` and each of its ancestors, farthest first. The filesystem root is
 * left out, and nothing else stops the climb: monorepos keep a `.mcp.json`
 * above the package they run in.
 */
export function ancestorChain(start: string): string[] {
  const chain: string[] = []
  let dir = start
  for (let parent = dirname(dir); parent !== dir; parent = dirname(dir)) {
    chain.unshift(dir)
    dir = parent
  }
  return chain
}

function readProjectChain(cwd: string): ScopeRead {
  const combined = nothing()
  for (const dir of ancestorChain(cwd)) {
    const level = readOptionalFile(join(dir, PROJECT_FILE), 'project')
    Object.assign(combined.servers, level.servers)
    combined.errors.push(...level.errors)
  }
  return combined
}

export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), MANAGED_FILE)
}

/** Decided once per process; an admin installs the file and a restart picks it up. */
export const doesEnterpriseMcpConfigExist = memoize(
  (): boolean =>
    parseMcpConfigFromFilePath({ filePath: getEnterpriseMcpFilePath(), expandVars: true, scope: 'enterprise' }).config !== null,
)

export function getMcpConfigsByScope(scope: ReadableScope): ScopeRead {
  if (scope === 'enterprise') return readOptionalFile(getEnterpriseMcpFilePath(), 'enterprise')
  if (!isSettingSourceEnabled(GATING_SOURCE[scope])) return nothing()
  switch (scope) {
    case 'project':
      return readProjectChain(getCwd())
    case 'user':
      return readStored(getGlobalConfig().mcpServers, 'user')
    case 'local':
      return readStored(getCurrentProjectConfig().mcpServers, 'local')
  }
}

export function getProjectMcpConfigsFromCwd(): ScopeRead {
  if (!isSettingSourceEnabled(GATING_SOURCE.project)) return nothing()
  return readOptionalFile(join(getCwd(), PROJECT_FILE), 'project')
}

/** Looks up by name only: approval, policy and the disabled list do not apply. */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const lookupOrder: ReadableScope[] = isRestrictedToPluginOnly('mcp')
    ? ['enterprise']
    : ['enterprise', 'local', 'project', 'user']
  for (const scope of lookupOrder) {
    const { servers } = getMcpConfigsByScope(scope)
    if (Object.hasOwn(servers, name)) return servers[name] ?? null
  }
  return null
}

// The VS Code extension's in-process server, the only one `--mcp-config` may
// bring while the managed file is in force.
const IDE_SDK_SERVER = 'claude-vscode'

export function areMcpConfigsAllowedWithEnterpriseMcpConfig(configs: Record<string, ScopedMcpServerConfig>): boolean {
  return Object.values(configs).every(config => config.type === 'sdk' && config.name === IDE_SDK_SERVER)
}
