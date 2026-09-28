/**
 * Plugin hooks are loaded before a start's hooks run, so that the hooks
 * plugins provide take part. A failed load never fails the start.
 */
import { shouldAllowManagedHooksOnly } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { loadPluginHooks } from 'src/plugins/loadPluginHooks.js'
import { logForDebugging } from 'src/shared/debug.js'
import { withDiagnosticsTiming } from 'src/shared/diagLogs.js'
import { ClaudeError, errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

export type StartEvent = 'SessionStart' | 'Setup'

/**
 * SessionStart runs at every start, resume, /clear and compaction, so its load
 * is timed in the diagnostics log and a failure reaches the error log. A Setup
 * failure only leaves a debug warning.
 */
const LOAD_POLICY: Record<StartEvent, { timed: boolean; logsError: boolean }> = {
  SessionStart: { timed: true, logsError: true },
  Setup: { timed: false, logsError: false },
}

/** Logged as `load_plugin_hooks_started`, then `_completed` or `_failed`. */
const LOAD_TIMING_EVENT = 'load_plugin_hooks'

const NETWORK_FAILURE =
  /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|network|fetch failed|unreachable|clone/i
const PERMISSION_FAILURE = /\b(EACCES|EPERM)\b|permission denied/i
const CONFIGURATION_FAILURE = /JSON|parse|invalid|schema|manifest/i

const FAILURE_ADVICE: ReadonlyArray<{ cause: RegExp; advice: string }> = [
  {
    cause: NETWORK_FAILURE,
    advice: 'This looks like a network problem: check the connection to the plugin marketplace.',
  },
  {
    cause: PERMISSION_FAILURE,
    advice: 'This looks like a permission problem: check that you own the plugin directories under the config directory.',
  },
  {
    cause: CONFIGURATION_FAILURE,
    advice: 'This looks like a configuration problem: check the plugin settings and each enabled plugin’s hooks file.',
  },
]

/**
 * A load failure as the error log records it: with the start it interrupted.
 * Logging the original error alone would record only its own stack.
 */
class PluginHookLoadError extends ClaudeError {
  constructor(start: string, cause: unknown) {
    super(`Plugin hooks failed to load for ${start}: ${errorMessage(cause)}`, { cause })
  }
}

export async function loadPluginHooksBeforeStart(event: StartEvent, query: string): Promise<void> {
  // Plugin hooks are untrusted code: a managed-hooks-only policy keeps them out.
  if (shouldAllowManagedHooksOnly()) return
  const policy = LOAD_POLICY[event]
  try {
    if (policy.timed) await withDiagnosticsTiming(LOAD_TIMING_EVENT, () => loadPluginHooks())
    else await loadPluginHooks()
  } catch (error) {
    if (policy.logsError) logError(new PluginHookLoadError(`${event} (${query})`, error))
    logForDebugging(pluginLoadWarning(error), { level: 'warn' })
  }
}

/** The debug warning for a failed load, with advice when the cause is recognizable. */
export function pluginLoadWarning(error: unknown): string {
  const message = errorMessage(error)
  const warning = `Plugin hooks failed to load; only the configured hooks run. ${message}`
  const advice = FAILURE_ADVICE.find(entry => entry.cause.test(message))?.advice
  return advice ? `${warning}\n${advice}` : warning
}
