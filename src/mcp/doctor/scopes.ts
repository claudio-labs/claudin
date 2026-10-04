import type { McpDoctorScopeFilter } from 'src/mcp/doctor.js'

/** The scopes the doctor reads, in the order their definitions are listed. */
export const DOCTOR_SCOPES: readonly McpDoctorScopeFilter[] = ['enterprise', 'local', 'project', 'user']

export function isDoctorScope(value: string): value is McpDoctorScopeFilter {
  return (DOCTOR_SCOPES as readonly string[]).includes(value)
}

/**
 * `--scope` for `mcp doctor`. Only the file-backed scopes are accepted: the
 * others (dynamic, claudeai, managed) are never read here, so a filter on one
 * could only ever produce an empty report.
 */
export function parseDoctorScopeFilter(raw: string): McpDoctorScopeFilter {
  if (isDoctorScope(raw)) return raw
  throw new Error(`Invalid scope: ${raw}. Must be one of: ${DOCTOR_SCOPES.join(', ')}`)
}
