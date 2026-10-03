/**
 * Where the auto-mode denial streak lives, and what happens when it reaches
 * its limit. A sub-agent with its own counter keeps it on its context (its
 * `setAppState` may not reach the session); everyone else keeps it in app
 * state.
 */
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { AbortError } from 'src/shared/errors.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordSuccess,
  shouldFallbackToPrompting,
} from 'src/permissions/denialTracking.js'

const AUTO_MODE_CLASSIFIER = 'auto-mode'

export function currentDenialState(context: ToolUseContext): DenialTrackingState {
  return (
    context.localDenialTracking ??
    context.getAppState().denialTracking ??
    createDenialTrackingState()
  )
}

export function persistDenialState(
  context: ToolUseContext,
  newState: DenialTrackingState,
): void {
  const ownCounter = context.localDenialTracking
  if (ownCounter) {
    ownCounter.consecutiveDenials = newState.consecutiveDenials
    ownCounter.totalDenials = newState.totalDenials
    return
  }
  context.setAppState(prev =>
    prev.denialTracking === newState ? prev : { ...prev, denialTracking: newState },
  )
}

/** Ends the streak; writes nothing when there was none. */
export function endDenialStreak(context: ToolUseContext): void {
  const before = currentDenialState(context)
  const after = recordSuccess(before)
  if (after !== before) persistDenialState(context, after)
}

function streakSummary(state: DenialTrackingState, totalLimitHit: boolean): string {
  return totalLimitHit
    ? `${state.totalDenials} actions were blocked this session by the auto mode classifier`
    : `${state.consecutiveDenials} consecutive actions were blocked by the auto mode classifier`
}

/**
 * At the limit, the blocked call goes back to the user as the ask it was,
 * so a person looks at what the classifier keeps refusing. Returns null
 * below the limit. With no one to ask, the turn is aborted instead.
 */
export function handleDenialLimitExceeded(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  classifierReason: string,
  _assistantMessage: AssistantMessage,
  tool: Tool,
  result: PermissionDecision,
  context: ToolUseContext,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) return null

  const totalLimitHit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  const summary = streakSummary(denialState, totalLimitHit)
  if (totalLimitHit) persistDenialState(context, createDenialTrackingState())

  if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
    throw new AbortError(
      `Stopped: too many classifier denials in headless mode (${summary}; the last one, on ${tool.name}: ${classifierReason})`,
    )
  }

  const ownReason = result.decisionReason
  return {
    ...result,
    decisionReason: {
      type: 'classifier',
      classifier:
        ownReason?.type === 'classifier' ? ownReason.classifier : AUTO_MODE_CLASSIFIER,
      reason: `${summary}. Please review the transcript before approving. Latest block: ${classifierReason}`,
    },
  }
}
