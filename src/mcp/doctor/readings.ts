import type { McpDoctorDependencies, McpDoctorScopeFilter } from 'src/mcp/doctor.js'
import { DOCTOR_SCOPES } from 'src/mcp/doctor/scopes.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { ValidationError } from 'src/platform/settings/validation.js'

type ServerTable = Record<string, ScopedMcpServerConfig>

export type ScopeServers = { scope: McpDoctorScopeFilter; servers: ServerTable }

/** Everything the doctor reads from configuration, once per call. */
export type DoctorReadings = {
  filtered: boolean
  scopes: ScopeServers[]
  validationErrors: ValidationError[]
  runtime: ServerTable
}

export type ReadingDeps = Pick<McpDoctorDependencies, 'getMcpConfigsByScope' | 'getAllMcpConfigs'>

export async function readConfiguration(
  scopeFilter: McpDoctorScopeFilter | undefined,
  deps: ReadingDeps,
): Promise<DoctorReadings> {
  const selected = scopeFilter ? [scopeFilter] : DOCTOR_SCOPES
  const reads = selected.map(scope => ({ scope, read: deps.getMcpConfigsByScope(scope) }))
  const { servers: runtime } = await deps.getAllMcpConfigs()
  return {
    filtered: scopeFilter !== undefined,
    scopes: reads.map(({ scope, read }) => ({ scope, servers: read.servers })),
    validationErrors: reads.flatMap(({ read }) => read.errors),
    runtime,
  }
}

/**
 * The names that get a report: every name a selected scope declares and,
 * unfiltered, every name the runtime would load. Sorted by UTF-16 code unit.
 */
export function reportedNames(readings: DoctorReadings): string[] {
  const names = new Set(readings.scopes.flatMap(({ servers }) => Object.keys(servers)))
  if (!readings.filtered) for (const name of Object.keys(readings.runtime)) names.add(name)
  return [...names].sort()
}
