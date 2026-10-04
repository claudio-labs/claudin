/**
 * One headersHelper call: the trust gate, the run, the reading of its output,
 * and the report of whatever went wrong. Nothing is cached, so a helper that
 * rotates a token is asked again for every transport built.
 */

import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { checkHasTrustDialogAccepted } from 'src/platform/config/config.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError, logMCPDebug, logMCPError } from 'src/shared/log.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpWebSocketServerConfig,
} from 'src/mcp/types.js'
import {
  type HelperOutputVerdict,
  parseHelperOutput,
} from 'src/mcp/headersHelper/parseOutput.js'
import {
  type HelperRunResult,
  runHelper,
} from 'src/mcp/headersHelper/runHelper.js'
import { decideHelperTrust } from 'src/mcp/headersHelper/trust.js'

export type RemoteServerConfig =
  | McpSSEServerConfig
  | McpHTTPServerConfig
  | McpWebSocketServerConfig

export const HELPER_TIMEOUT_MS = 10_000
const HELPER_MAX_OUTPUT_BYTES = 1024 * 1024
const HELPER_KILL_GRACE_MS = 1_000

export type HeadersHelperDeps = {
  isInteractive: () => boolean
  isWorkspaceTrusted: () => boolean
  run: (command: string, env: NodeJS.ProcessEnv) => Promise<HelperRunResult>
  /** The server's own MCP log. */
  logToServer: (serverName: string, message: string) => void
  /** The session error log. */
  logError: (error: Error) => void
  /** Debug detail that never carries helper output. */
  logDebug: (serverName: string, message: string) => void
}

export const defaultHeadersHelperDeps: HeadersHelperDeps = {
  isInteractive: () => !getIsNonInteractiveSession(),
  isWorkspaceTrusted: checkHasTrustDialogAccepted,
  run: (command, env) =>
    runHelper(command, {
      env,
      timeoutMs: HELPER_TIMEOUT_MS,
      maxOutputBytes: HELPER_MAX_OUTPUT_BYTES,
      killGraceMs: HELPER_KILL_GRACE_MS,
    }),
  logToServer: logMCPError,
  logError,
  logDebug: logMCPDebug,
}

function scopeOf(config: object): string | undefined {
  return 'scope' in config && typeof config.scope === 'string'
    ? config.scope
    : undefined
}

function rejectionReason(
  serverName: string,
  verdict: Exclude<HelperOutputVerdict, { ok: true }>,
): string {
  const subject = `headersHelper for MCP server '${serverName}'`
  switch (verdict.problem) {
    case 'empty':
      return `${subject} did not return a valid value`
    case 'not-json':
      return `${subject} did not print valid JSON`
    case 'not-object':
      return `${subject} must return a JSON object with string key-value pairs`
    case 'non-string-value':
      return `${subject} returned non-string value for key "${verdict.key}": ${verdict.valueType}`
  }
}

function report(
  deps: HeadersHelperDeps,
  serverName: string,
  reason: string,
): void {
  const message = `Error getting MCP headers from headersHelper for server '${serverName}': ${reason}`
  deps.logToServer(serverName, message)
  deps.logError(new Error(message))
}

export async function readHelperHeaders(
  serverName: string,
  config: RemoteServerConfig,
  deps: HeadersHelperDeps,
): Promise<Record<string, string> | null> {
  const command = config.headersHelper
  if (!command) return null

  try {
    const decision = decideHelperTrust(
      scopeOf(config),
      deps.isInteractive(),
      deps.isWorkspaceTrusted,
    )
    if (decision === 'refuse') {
      deps.logToServer(
        serverName,
        `headersHelper for MCP server '${serverName}' was not run: workspace trust has not been accepted for this project yet. The server connects without the helper's headers until it is.`,
      )
      return null
    }

    const run = await deps.run(command, {
      ...process.env,
      CLAUDIN_MCP_SERVER_NAME: serverName,
      CLAUDIN_MCP_SERVER_URL: config.url,
    })
    if (!run.ok) {
      deps.logDebug(serverName, `headersHelper run failed: ${run.failure}`)
      report(
        deps,
        serverName,
        `headersHelper for MCP server '${serverName}' did not return a valid value`,
      )
      return null
    }

    const verdict = parseHelperOutput(run.stdout)
    if (!verdict.ok) {
      report(deps, serverName, rejectionReason(serverName, verdict))
      return null
    }
    deps.logDebug(
      serverName,
      `headersHelper supplied ${Object.keys(verdict.headers).length} header(s)`,
    )
    return verdict.headers
  } catch (error) {
    report(deps, serverName, errorMessage(error))
    return null
  }
}
