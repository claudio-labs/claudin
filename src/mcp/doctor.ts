import { clearServerCache, connectToServer } from 'src/mcp/client.js'
import { getAllMcpConfigs, getMcpConfigsByScope, isMcpServerDisabled } from 'src/mcp/config.js'
import { type DefinitionLookups, resolveDefinitions } from 'src/mcp/doctor/definitions.js'
import {
  findingsFromValidationErrors,
  liveFindings,
  notFoundFinding,
  shadowingFindings,
  type SortedValidationFindings,
  sortValidationFindings,
  stateFindings,
} from 'src/mcp/doctor/findings.js'
import { idleCheck, runLiveCheck } from 'src/mcp/doctor/liveCheck.js'
import { type DoctorReadings, readConfiguration, reportedNames } from 'src/mcp/doctor/readings.js'
import { summarize } from 'src/mcp/doctor/summary.js'
import { describeMcpConfigFilePath, getProjectMcpServerStatus } from 'src/mcp/utils.js'

export { findingsFromValidationErrors }

export type McpDoctorSeverity = 'info' | 'warn' | 'error'
export type McpDoctorScopeFilter = 'local' | 'project' | 'user' | 'enterprise'

export type McpDoctorFinding = {
  blocking: boolean
  code: string
  message: string
  remediation?: string
  scope?: string
  serverName?: string
  severity: McpDoctorSeverity
  sourcePath?: string
}

export type McpDoctorLiveCheck = {
  attempted: boolean
  durationMs?: number
  error?: string
  result?: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'skipped'
}

export type McpDoctorDefinition = {
  name: string
  sourceType:
    | 'local'
    | 'project'
    | 'user'
    | 'enterprise'
    | 'managed'
    | 'plugin'
    | 'claudeai'
    | 'dynamic'
    | 'internal'
  sourcePath?: string
  transport?: string
  runtimeVisible: boolean
  runtimeActive: boolean
  pendingApproval?: boolean
  disabled?: boolean
}

export type McpDoctorServerReport = {
  serverName: string
  requestedByUser: boolean
  definitions: McpDoctorDefinition[]
  liveCheck: McpDoctorLiveCheck
  findings: McpDoctorFinding[]
}

export type McpDoctorDependencies = {
  getAllMcpConfigs: typeof getAllMcpConfigs
  getMcpConfigsByScope: typeof getMcpConfigsByScope
  getProjectMcpServerStatus: typeof getProjectMcpServerStatus
  isMcpServerDisabled: typeof isMcpServerDisabled
  describeMcpConfigFilePath: typeof describeMcpConfigFilePath
  connectToServer: typeof connectToServer
  clearServerCache: typeof clearServerCache
}

export type McpDoctorReport = {
  generatedAt: string
  targetName?: string
  scopeFilter?: McpDoctorScopeFilter
  configOnly: boolean
  summary: {
    totalReports: number
    healthy: number
    warnings: number
    blocking: number
  }
  findings: McpDoctorFinding[]
  servers: McpDoctorServerReport[]
}

type DoctorOptions = { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter }

const REAL_DEPENDENCIES: McpDoctorDependencies = {
  getAllMcpConfigs,
  getMcpConfigsByScope,
  getProjectMcpServerStatus,
  isMcpServerDisabled,
  describeMcpConfigFilePath,
  connectToServer,
  clearServerCache,
}

export function buildEmptyDoctorReport(options: {
  configOnly: boolean
  scopeFilter?: McpDoctorScopeFilter
  targetName?: string
}): McpDoctorReport {
  return {
    generatedAt: new Date().toISOString(),
    targetName: options.targetName,
    scopeFilter: options.scopeFilter,
    configOnly: options.configOnly,
    summary: { totalReports: 0, healthy: 0, warnings: 0, blocking: 0 },
    findings: [],
    servers: [],
  }
}

type ServerContext = {
  readings: DoctorReadings
  validation: SortedValidationFindings
  configOnly: boolean
  requestedByUser: boolean
  deps: McpDoctorDependencies
}

function lookupsFrom(deps: McpDoctorDependencies): DefinitionLookups {
  return {
    isDisabled: deps.isMcpServerDisabled,
    projectStatus: deps.getProjectMcpServerStatus,
    describeFile: deps.describeMcpConfigFilePath,
  }
}

async function examineServer(name: string, ctx: ServerContext): Promise<McpDoctorServerReport> {
  const { readings, deps } = ctx
  const { definitions, running, plan } = resolveDefinitions(
    name,
    { scopes: readings.scopes, runtimeConfig: readings.runtime[name], filtered: readings.filtered },
    lookupsFrom(deps),
  )
  const liveCheck = ctx.configOnly
    ? idleCheck('skipped')
    : plan.kind === 'connect'
      ? await runLiveCheck(name, plan.config, deps)
      : idleCheck(plan.result)

  return {
    serverName: name,
    requestedByUser: ctx.requestedByUser,
    definitions,
    liveCheck,
    findings: [
      ...(ctx.validation.byServer.get(name) ?? []),
      ...shadowingFindings(name, definitions, running),
      ...stateFindings(name, definitions),
      ...(definitions.length === 0 ? [notFoundFinding(name)] : []),
      ...liveFindings(name, running, liveCheck),
    ],
  }
}

async function runDoctor(
  names: (readings: DoctorReadings) => string[],
  options: DoctorOptions & { targetName?: string },
  deps: McpDoctorDependencies,
): Promise<McpDoctorReport> {
  const envelope = buildEmptyDoctorReport(options)
  const readings = await readConfiguration(options.scopeFilter, deps)
  const validation = sortValidationFindings(findingsFromValidationErrors(readings.validationErrors))
  const ctx: ServerContext = {
    readings,
    validation,
    configOnly: options.configOnly,
    requestedByUser: options.targetName !== undefined,
    deps,
  }
  // Checked concurrently; Promise.all keeps the name order.
  const servers = await Promise.all(names(readings).map(name => examineServer(name, ctx)))
  return {
    ...envelope,
    summary: summarize(validation.global, servers),
    findings: validation.global,
    servers,
  }
}

export async function doctorAllServers(
  options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter } = {
    configOnly: false,
  },
  deps: McpDoctorDependencies = REAL_DEPENDENCIES,
): Promise<McpDoctorReport> {
  return runDoctor(reportedNames, options, deps)
}

export async function doctorServer(
  name: string,
  options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter },
  deps: McpDoctorDependencies = REAL_DEPENDENCIES,
): Promise<McpDoctorReport> {
  return runDoctor(() => [name], { ...options, targetName: name }, deps)
}
