import type { McpDoctorDefinition } from 'src/mcp/doctor.js'
import type { ScopeServers } from 'src/mcp/doctor/readings.js'
import type { ProjectServerStatus } from 'src/mcp/projectServerStatus.js'
import type { ConfigScope, ScopedMcpServerConfig } from 'src/mcp/types.js'

type SourceType = McpDoctorDefinition['sourceType']

export type DefinitionLookups = {
  isDisabled: (name: string) => boolean
  projectStatus: (name: string) => ProjectServerStatus
  describeFile: (scope: ConfigScope) => string
}

/** What the live check has to do for a server, before `configOnly` is applied. */
type CheckPlan =
  | { kind: 'connect'; config: ScopedMcpServerConfig }
  | { kind: 'idle'; result: 'pending' | 'disabled' | 'skipped' }

export type ResolvedServer = {
  definitions: McpDoctorDefinition[]
  running: McpDoctorDefinition | undefined
  plan: CheckPlan
}

export type DefinitionInput = {
  scopes: ScopeServers[]
  runtimeConfig: ScopedMcpServerConfig | undefined
  filtered: boolean
}

const FILE_BACKED: ReadonlySet<SourceType> = new Set(['enterprise', 'local', 'project', 'user'])

export function isFileBacked(sourceType: SourceType): boolean {
  return FILE_BACKED.has(sourceType)
}

function transportOf(config: ScopedMcpServerConfig): string {
  return config.type ?? 'stdio'
}

function sourceTypeOf(config: ScopedMcpServerConfig): SourceType {
  return config.scope === 'dynamic' && config.pluginSource ? 'plugin' : config.scope
}

/** Source type, transport, and what the transport reaches: its URL or its command line. */
function identityOf(config: ScopedMcpServerConfig): string {
  const target = 'url' in config ? [config.url] : 'command' in config ? [config.command, config.args] : []
  return JSON.stringify([sourceTypeOf(config), transportOf(config), ...target])
}

function observedSourcePath(config: ScopedMcpServerConfig, lookups: DefinitionLookups): string {
  const sourceType = sourceTypeOf(config)
  if (sourceType === 'plugin') return `plugin:${config.pluginSource}`
  if (sourceType === 'claudeai') return 'claude.ai'
  return isFileBacked(sourceType) ? lookups.describeFile(config.scope) : config.scope
}

function sameSource(a: McpDoctorDefinition, b: McpDoctorDefinition): boolean {
  return a.sourceType === b.sourceType && a.sourcePath === b.sourcePath && a.transport === b.transport
}

function planFor(definitions: McpDoctorDefinition[], runtimeConfig: ScopedMcpServerConfig | undefined): CheckPlan {
  if (runtimeConfig && definitions.some(d => d.runtimeActive)) return { kind: 'connect', config: runtimeConfig }
  if (definitions.some(d => d.pendingApproval)) return { kind: 'idle', result: 'pending' }
  if (definitions.some(d => d.disabled)) return { kind: 'idle', result: 'disabled' }
  return { kind: 'idle', result: 'skipped' }
}

/**
 * Lists where a name is declared and marks the declaration the runtime would
 * load. The identity carries the source type, and each scope declares a name
 * once, so at most one declaration can match. When none of them runs, the
 * runtime's own config is appended as an observed definition, so the report
 * shows what actually runs.
 */
export function resolveDefinitions(name: string, input: DefinitionInput, lookups: DefinitionLookups): ResolvedServer {
  const { runtimeConfig } = input
  const disabled = lookups.isDisabled(name)
  const runtimeIdentity = runtimeConfig && !disabled ? identityOf(runtimeConfig) : undefined

  const definitions = input.scopes.flatMap(({ scope, servers }): McpDoctorDefinition[] => {
    const config = servers[name]
    if (!config) return []
    const active = identityOf(config) === runtimeIdentity
    return [
      {
        name,
        sourceType: scope,
        sourcePath: lookups.describeFile(scope),
        transport: transportOf(config),
        runtimeVisible: active,
        runtimeActive: active,
        pendingApproval: scope === 'project' && lookups.projectStatus(name) === 'pending',
        disabled,
      },
    ]
  })

  const mayObserve = definitions.length > 0 ? !definitions.some(d => d.runtimeActive) : !input.filtered
  if (runtimeConfig && mayObserve) {
    const observed: McpDoctorDefinition = {
      name,
      sourceType: sourceTypeOf(runtimeConfig),
      sourcePath: observedSourcePath(runtimeConfig, lookups),
      transport: transportOf(runtimeConfig),
      runtimeVisible: !disabled,
      runtimeActive: !disabled,
      disabled,
    }
    if (!definitions.some(d => sameSource(d, observed))) definitions.push(observed)
  }

  return {
    definitions,
    running: definitions.find(d => d.runtimeActive),
    plan: planFor(definitions, runtimeConfig),
  }
}
