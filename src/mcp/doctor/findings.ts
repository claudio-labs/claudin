import type { McpDoctorDefinition, McpDoctorFinding, McpDoctorLiveCheck, McpDoctorSeverity } from 'src/mcp/doctor.js'
import { isFileBacked } from 'src/mcp/doctor/definitions.js'
import type { ValidationError } from 'src/platform/settings/validation.js'

type McpDoctorFindingCode =
  | 'config.invalid_json'
  | 'config.missing_env_vars'
  | 'config.windows_npx_wrapper_required'
  | 'config.invalid_schema'
  | 'config.validation_error'
  | 'duplicate.same_name_multiple_scopes'
  | 'scope.shadowed'
  | 'state.pending_project_approval'
  | 'state.disabled'
  | 'state.not_found'
  | 'auth.needs_auth'
  | 'health.failed'
  | 'stdio.command_not_found'

type FindingFields = {
  code: McpDoctorFindingCode
  message: string
  remediation?: string
  scope?: string
  serverName?: string
  sourcePath?: string
}

/** Builds a finding with its keys in the `--json` order. */
function finding(severity: Exclude<McpDoctorSeverity, 'info'>, fields: FindingFields): McpDoctorFinding {
  return {
    blocking: severity === 'error',
    code: fields.code,
    message: fields.message,
    remediation: fields.remediation,
    scope: fields.scope,
    serverName: fields.serverName,
    severity,
    sourcePath: fields.sourcePath,
  }
}

// --- validation errors ------------------------------------------------------

type MessageRule = { code: McpDoctorFindingCode; matches: (message: string) => boolean }

/** First match wins; anything unmatched is a generic validation error. */
const VALIDATION_RULES: readonly MessageRule[] = [
  { code: 'config.invalid_json', matches: m => m === 'MCP config is not a valid JSON' },
  { code: 'config.missing_env_vars', matches: m => m.startsWith('Missing environment variables:') },
  // The wording mcp/config emits for a bare `npx` command on Windows.
  { code: 'config.windows_npx_wrapper_required', matches: m => m.includes('Windows cannot launch npx directly') },
  { code: 'config.invalid_schema', matches: m => m === 'Does not adhere to MCP server configuration schema' },
]

function validationCode(message: string): McpDoctorFindingCode {
  return VALIDATION_RULES.find(rule => rule.matches(message))?.code ?? 'config.validation_error'
}

export function findingsFromValidationErrors(validationErrors: ValidationError[]): McpDoctorFinding[] {
  return validationErrors.map(error =>
    finding(error.mcpErrorMetadata?.severity === 'fatal' ? 'error' : 'warn', {
      code: validationCode(error.message),
      message: error.message,
      remediation: error.suggestion,
      scope: error.mcpErrorMetadata?.scope,
      serverName: error.mcpErrorMetadata?.serverName,
      sourcePath: error.file,
    }),
  )
}

export type SortedValidationFindings = {
  global: McpDoctorFinding[]
  byServer: ReadonlyMap<string, McpDoctorFinding[]>
}

/** A finding naming a server belongs to that server's report; the rest are global. */
export function sortValidationFindings(findings: McpDoctorFinding[]): SortedValidationFindings {
  const global: McpDoctorFinding[] = []
  const byServer = new Map<string, McpDoctorFinding[]>()
  for (const f of findings) {
    if (f.serverName === undefined) global.push(f)
    else byServer.set(f.serverName, [...(byServer.get(f.serverName) ?? []), f])
  }
  return { global, byServer }
}

// --- definitions ------------------------------------------------------------

export function shadowingFindings(
  serverName: string,
  definitions: McpDoctorDefinition[],
  running: McpDoctorDefinition | undefined,
): McpDoctorFinding[] {
  if (definitions.filter(d => isFileBacked(d.sourceType)).length < 2) return []
  const which = running
    ? `the active source is ${running.sourceType}`
    : 'none of its definitions is active'
  return [
    finding('warn', {
      code: 'duplicate.same_name_multiple_scopes',
      message: `"${serverName}" is declared in more than one scope; ${which}.`,
      remediation: 'Keep a single declaration of this server, or rename one of them.',
      serverName,
    }),
    finding('warn', {
      code: 'scope.shadowed',
      message: `Only one declaration of "${serverName}" is loaded; the others are shadowed by scope precedence.`,
      remediation: 'Remove the declarations that never load so the configuration says what runs.',
      serverName,
    }),
  ]
}

export function stateFindings(serverName: string, definitions: McpDoctorDefinition[]): McpDoctorFinding[] {
  return definitions.flatMap(d => {
    const found: McpDoctorFinding[] = []
    if (d.pendingApproval) {
      found.push(
        finding('warn', {
          code: 'state.pending_project_approval',
          message: `"${serverName}" from .mcp.json is waiting for project approval.`,
          remediation: 'Start an interactive session in this project and approve the server, or list it in enabledMcpjsonServers.',
          scope: 'project',
          serverName,
          sourcePath: d.sourcePath,
        }),
      )
    }
    if (d.disabled) {
      found.push(
        finding('warn', {
          code: 'state.disabled',
          message: `"${serverName}" is disabled.`,
          remediation: 'Enable it from /mcp if it should run.',
          serverName,
          sourcePath: d.sourcePath,
        }),
      )
    }
    return found
  })
}

export function notFoundFinding(serverName: string): McpDoctorFinding {
  return finding('error', {
    code: 'state.not_found',
    message: `No selected configuration source declares "${serverName}".`,
    remediation: 'Check the name with `claudin mcp list`, or add the server with `claudin mcp add`.',
    serverName,
  })
}

// --- the live check -----------------------------------------------------------

const NOT_FOUND = 'not found'

export function liveFindings(
  serverName: string,
  running: McpDoctorDefinition | undefined,
  check: McpDoctorLiveCheck,
): McpDoctorFinding[] {
  const sourcePath = running?.sourcePath
  if (check.result === 'needs-auth') {
    return [
      finding('warn', {
        code: 'auth.needs_auth',
        message: `"${serverName}" needs authentication before it can be used.`,
        remediation: 'Authenticate the server from /mcp.',
        serverName,
        sourcePath,
      }),
    ]
  }
  if (check.result !== 'failed') return []

  const detail = check.error ? `: ${check.error}` : ''
  const missingCommand =
    running?.transport === 'stdio' && check.error !== undefined && check.error.toLowerCase().includes(NOT_FOUND)
  return [
    finding('error', {
      code: missingCommand ? 'stdio.command_not_found' : 'health.failed',
      message: `Live check of "${serverName}" failed${detail}`,
      remediation: missingCommand
        ? 'Install the command, or give its absolute path, so that it can be found on PATH.'
        : 'Check that the server starts or is reachable with this configuration, then run the doctor again.',
      serverName,
      sourcePath,
    }),
  ]
}
