import { feature } from 'bun:bundle'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import memoize from 'lodash-es/memoize.js'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import {
  setLastAPIRequest,
  setLastAPIRequestMessages,
} from 'src/platform/bootstrap/state.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { TICK_TAG } from 'src/shared/constants/xml.js'
import {
  type LogOption,
} from 'src/shared/types/logs.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from 'src/shared/text/displayTags.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { toError } from 'src/shared/errors.js'
import { isEssentialTrafficOnly } from 'src/platform/config/privacyLevel.js'

/**
 * Gets the display title for a log/session with fallback logic.
 * Skips firstPrompt if it starts with a tick/goal tag (autonomous mode auto-prompt).
 * Strips display-unfriendly tags (like <ide_opened_file>) from the result.
 * Falls back to a truncated session ID when no other title is available.
 */
export function getLogDisplayTitle(
  log: LogOption,
  defaultTitle?: string,
): string {
  // Skip firstPrompt if it's a tick/goal message (autonomous mode auto-prompt)
  const isAutonomousPrompt = log.firstPrompt?.startsWith(`<${TICK_TAG}>`)
  // Strip display-unfriendly tags (command-name, ide_opened_file, etc.) early
  // so that command-only prompts (e.g. /clear) become empty and fall through
  // to the next fallback instead of showing raw XML tags.
  // Note: stripDisplayTags returns the original when stripping yields empty,
  // so we call stripDisplayTagsAllowEmpty to detect command-only prompts.
  const strippedFirstPrompt = log.firstPrompt
    ? stripDisplayTagsAllowEmpty(log.firstPrompt)
    : ''
  const useFirstPrompt = strippedFirstPrompt && !isAutonomousPrompt
  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    (useFirstPrompt ? strippedFirstPrompt : undefined) ||
    defaultTitle ||
    // For autonomous sessions without other context, show a meaningful label
    (isAutonomousPrompt ? 'Autonomous session' : undefined) ||
    // Fall back to truncated session ID for lite logs with no metadata
    (log.sessionId ? log.sessionId.slice(0, 8) : '') ||
    ''
  // Strip display-unfriendly tags (like <ide_opened_file>) for cleaner titles
  return stripDisplayTags(title).trim()
}

export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

// In-memory error log for recent errors
// Moved from bootstrap/state.ts to break import cycle
const MAX_IN_MEMORY_ERRORS = 100
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift() // Remove oldest error
  }
  inMemoryErrorLog.push(errorInfo)
}

/**
 * Sink interface for the error logging backend
 */
export type ErrorLogSink = {
  logError: (error: Error) => void
  logMCPError: (serverName: string, error: unknown) => void
  logMCPDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMCPLogsPath: (serverName: string) => string
}

// Queued events for events logged before sink is attached
type QueuedErrorEvent =
  | { type: 'error'; error: Error }
  | { type: 'mcpError'; serverName: string; error: unknown }
  | { type: 'mcpDebug'; serverName: string; message: string }

const errorQueue: QueuedErrorEvent[] = []

// Sink - initialized during app startup
let errorLogSink: ErrorLogSink | null = null

/**
 * Attach the error log sink that will receive all error events.
 * Queued events are drained immediately to ensure no errors are lost.
 *
 * Idempotent: if a sink is already attached, this is a no-op. This allows
 * calling from both the preAction hook (for subcommands) and setup() (for
 * the default command) without coordination.
 */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) {
    return
  }
  errorLogSink = newSink

  // Drain the queue immediately - errors should not be delayed
  if (errorQueue.length > 0) {
    const queuedEvents = [...errorQueue]
    errorQueue.length = 0

    for (const event of queuedEvents) {
      switch (event.type) {
        case 'error':
          errorLogSink.logError(event.error)
          break
        case 'mcpError':
          errorLogSink.logMCPError(event.serverName, event.error)
          break
        case 'mcpDebug':
          errorLogSink.logMCPDebug(event.serverName, event.message)
          break
      }
    }
  }
}

/**
 * Logs an error to multiple destinations for debugging and monitoring.
 *
 * This function logs errors to:
 * - Debug logs (visible via `claude --debug` or `tail -f ~/.claude/debug/latest`)
 * - In-memory error log (accessible via `getInMemoryErrors()`, useful for including
 *   in bug reports or displaying recent errors to users)
 * - Persistent error log file (only for internal 'ant' users, stored in ~/.claude/errors/)
 *
 * Usage:
 * ```ts
 * logError(new Error('Failed to connect'))
 * ```
 *
 * To view errors:
 * - Debug: Run `claude --debug` or `tail -f ~/.claude/debug/latest`
 * - In-memory: Call `getInMemoryErrors()` to get recent errors for the current session
 */
const isHardFailMode = memoize((): boolean => {
  return process.argv.includes('--hard-fail')
})

export function logError(error: unknown): void {
  const err = toError(error)
  if (feature('HARD_FAIL') && isHardFailMode()) {
    // biome-ignore lint/suspicious/noConsole:: intentional crash output
    console.error('[HARD FAIL] logError called')
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
  try {
    // Check if error reporting should be disabled
    const transport = tryGetActiveProvider()?.transport
    if (
      // Cloud providers (Bedrock/Vertex/Foundry) always disable features
      transport === 'bedrock' ||
      transport === 'vertex' ||
      transport === 'foundry' ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    const errorStr = err.stack || err.message

    const errorInfo = {
      error: errorStr,
      timestamp: new Date().toISOString(),
    }

    // Always add to in-memory log (no dependencies needed)
    addToInMemoryErrorLog(errorInfo)

    // If sink not attached, queue the event
    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    errorLogSink.logError(err)
  } catch {
    // pass
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrorLog]
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    // If sink not attached, queue the event
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpError', serverName, error })
      return
    }

    errorLogSink.logMCPError(serverName, error)
  } catch {
    // Silently fail
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    // If sink not attached, queue the event
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpDebug', serverName, message })
      return
    }

    errorLogSink.logMCPDebug(serverName, message)
  } catch {
    // Silently fail
  }
}

/**
 * Captures the last API request for inclusion in bug reports.
 */
export function captureAPIRequest(
  params: BetaMessageStreamParams,
  querySource?: QuerySource,
): void {
  // startsWith, not exact match — users with non-default output styles get
  // variants like 'repl_main_thread:outputStyle:Explanatory' (querySource.ts).
  if (!querySource || !querySource.startsWith('repl_main_thread')) {
    return
  }

  // Store params WITHOUT messages to avoid retaining the entire conversation
  // for all users. Messages are already persisted to the transcript file and
  // available via React state.
  const { messages, ...paramsWithoutMessages } = params
  setLastAPIRequest(paramsWithoutMessages)
  setLastAPIRequestMessages(null)
}
