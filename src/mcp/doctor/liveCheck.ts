import type { McpDoctorDependencies, McpDoctorLiveCheck } from 'src/mcp/doctor.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'

export type LiveCheckDeps = Pick<McpDoctorDependencies, 'connectToServer' | 'clearServerCache'>

export function idleCheck(result: 'pending' | 'disabled' | 'skipped'): McpDoctorLiveCheck {
  return { attempted: false, result }
}

function fromConnection(connection: MCPServerConnection, durationMs: number): McpDoctorLiveCheck {
  if (connection.type === 'failed') {
    return { attempted: true, result: 'failed', durationMs, error: connection.error }
  }
  return { attempted: true, result: connection.type, durationMs }
}

/**
 * Connects once, maps the outcome, and always clears the connection so no
 * process it started outlives the call. Never throws: a connection function
 * that throws is this server's failure, not the whole report's.
 */
export async function runLiveCheck(
  name: string,
  config: ScopedMcpServerConfig,
  deps: LiveCheckDeps,
): Promise<McpDoctorLiveCheck> {
  const startedAt = Date.now()
  let check: McpDoctorLiveCheck
  try {
    check = fromConnection(await deps.connectToServer(name, config), Date.now() - startedAt)
  } catch (error) {
    check = { attempted: true, result: 'failed', durationMs: Date.now() - startedAt, error: errorMessage(error) }
  }
  try {
    await deps.clearServerCache(name, config)
  } catch (error) {
    // The outcome is already known; a failed cleanup must not change it.
    logForDebugging(`mcp doctor: clearing "${name}" failed: ${errorMessage(error)}`, { level: 'warn' })
  }
  return check
}
