import { getPlatform } from 'src/shared/proc/platform.js'
import type { ValidationError } from 'src/platform/settings/validation.js'
import { type ConfigScope, type McpJsonConfig, McpJsonConfigSchema, type McpServerConfig } from 'src/mcp/types.js'
import { expandServerPlaceholders } from 'src/mcp/config/expand.js'
import { type McpFileRead, readMcpFile } from 'src/mcp/config/jsonFile.js'

export type McpParseResult = {
  config: McpJsonConfig | null
  errors: ValidationError[]
}

export type McpParseParams = {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}

export type McpFileParams = {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}

const OFF_SCHEMA = 'Does not adhere to MCP server configuration schema'
// `npx` named bare or as the last segment of a path; `npx.cmd` is already runnable.
const BARE_NPX = /(?:^|[\\/])npx$/

type Origin = { scope: ConfigScope; filePath?: string }

function stamp(origin: Origin, error: ValidationError): ValidationError {
  return origin.filePath === undefined ? error : { ...error, file: origin.filePath }
}

function fatal(origin: Origin, path: string, message: string, suggestion?: string): ValidationError {
  const error: ValidationError = { path, message, mcpErrorMetadata: { scope: origin.scope, severity: 'fatal' } }
  return stamp(origin, suggestion === undefined ? error : { ...error, suggestion })
}

function serverWarning(origin: Origin, serverName: string, message: string, suggestion: string): ValidationError {
  return stamp(origin, {
    path: `mcpServers.${serverName}`,
    message,
    suggestion,
    mcpErrorMetadata: { scope: origin.scope, serverName, severity: 'warning' },
  })
}

function needsCmdWrapper(server: McpServerConfig): boolean {
  return (server.type === undefined || server.type === 'stdio') && BARE_NPX.test(server.command)
}

/**
 * Validates `{ mcpServers }`, then expands placeholders per server. Any
 * schema issue rejects the whole object; unset variables and a bare Windows
 * `npx` only warn.
 */
export function parseMcpConfig(params: McpParseParams): McpParseResult {
  const origin: Origin = { scope: params.scope, filePath: params.filePath }
  const checked = McpJsonConfigSchema().safeParse(params.configObject)
  if (!checked.success) {
    return {
      config: null,
      errors: checked.error.issues.map(issue => fatal(origin, issue.path.map(String).join('.'), OFF_SCHEMA)),
    }
  }

  const onWindows = getPlatform() === 'windows'
  const servers: Record<string, McpServerConfig> = {}
  const warnings: ValidationError[] = []
  for (const [name, declared] of Object.entries(checked.data.mcpServers)) {
    const { server, missing } = params.expandVars ? expandServerPlaceholders(declared) : { server: declared, missing: [] }
    if (missing.length > 0) {
      const names = missing.join(', ')
      warnings.push(
        serverWarning(origin, name, `Missing environment variables: ${names}`, `Set the following environment variables: ${names}`),
      )
    }
    if (onWindows && needsCmdWrapper(server)) {
      warnings.push(
        serverWarning(
          origin,
          name,
          "Windows cannot launch npx directly here: it needs a 'cmd /c' wrapper",
          'Use "cmd" as the command, with args ["/c", "npx", ...]',
        ),
      )
    }
    servers[name] = server
  }
  return { config: { mcpServers: servers }, errors: warnings }
}

/** Turns a file read into a parse result; a missing file is an error here. */
export function parseMcpFileRead(read: McpFileRead, params: McpFileParams): McpParseResult {
  const origin: Origin = { scope: params.scope, filePath: params.filePath }
  switch (read.kind) {
    case 'missing':
      return {
        config: null,
        errors: [fatal(origin, '', `MCP config file not found: ${params.filePath}`, 'Check that the file path is correct')],
      }
    case 'unreadable':
      return {
        config: null,
        errors: [fatal(origin, '', `Failed to read file: ${read.reason}`, 'Check file permissions and ensure the file exists')],
      }
    case 'malformed':
      return {
        config: null,
        errors: [fatal(origin, '', 'MCP config is not a valid JSON', 'Fix the JSON syntax errors in the file')],
      }
    case 'parsed':
      return parseMcpConfig({ configObject: read.value, expandVars: params.expandVars, scope: params.scope, filePath: params.filePath })
  }
}

export function parseMcpConfigFromFilePath(params: McpFileParams): McpParseResult {
  return parseMcpFileRead(readMcpFile(params.filePath), params)
}
