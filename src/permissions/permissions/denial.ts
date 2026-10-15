import type { ToolUseContext } from 'src/tools/Tool.js'
import type { YoloClassifierResult } from 'src/shared/types/permissions.js'
import { logForDebugging } from 'src/shared/debug.js'
import { AbortError } from 'src/shared/errors.js'
import type {
  PermissionAskDecision,
  PermissionDenyDecision,
} from 'src/permissions/PermissionResult.js'
import {
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
} from 'src/agent/messages/rejection.js'
import {
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordDenial,
  shouldFallbackToPrompting,
} from 'src/permissions/denialTracking.js'

/** All a denial-state write needs of the tool-use context. */
type DenialStateContext = Pick<ToolUseContext, 'localDenialTracking' | 'setAppState'>

/** Why a block falls back to asking the user, and whether headless gives up. */
type ClassifierFallback = { cause: string; abortsHeadless: boolean }

/**
 * A blocking classifier result that is not a verdict on the action, so auto
 * mode asks the user instead of denying; null for a real block.
 *
 * - Too long a transcript, or a deterministic 4xx (malformed request, bad
 *   header, auth failure): permanent, so headless — with no one to ask —
 *   aborts rather than deny-retry-deny without ever reaching the denial limit.
 * - A refusal: the API declined the classifier request, it did not block the
 *   action. Denying it read as "blocked for safety" and sent the model
 *   hunting for a workaround, 32 times in the 2026-10-08..15 census, in runs,
 *   since the next action carries the same transcript. Headless keeps the
 *   ordinary denial, which counts toward the denial limit.
 * - A timeout: the wait already happened, and denying with retry guidance
 *   would spend it again. Transient, so headless denies with that guidance.
 */
export function classifierFallback(
  result: Pick<
    YoloClassifierResult,
    'transcriptTooLong' | 'deterministic' | 'refused' | 'timedOut'
  >,
): ClassifierFallback | null {
  if (result.transcriptTooLong) {
    return { cause: 'transcript exceeded context window', abortsHeadless: true }
  }
  if (result.deterministic) {
    return { cause: 'request failed with a deterministic error', abortsHeadless: true }
  }
  if (result.refused) {
    return { cause: 'declined to assess this transcript', abortsHeadless: false }
  }
  if (result.timedOut) {
    return { cause: 'exceeded its time budget', abortsHeadless: false }
  }
  return null
}

/**
 * Persist denial tracking state. For async subagents with localDenialTracking,
 * mutate the local state in place (since setAppState is a no-op). Otherwise,
 * write to appState as usual.
 */
export function persistDenialState(
  context: DenialStateContext,
  newState: DenialTrackingState,
): void {
  if (context.localDenialTracking) {
    Object.assign(context.localDenialTracking, newState)
  } else {
    context.setAppState(prev => {
      // recordSuccess returns the same reference when state is
      // unchanged. Returning prev here lets store.setState's Object.is check
      // skip the listener loop entirely.
      if (prev.denialTracking === newState) return prev
      return { ...prev, denialTracking: newState }
    })
  }
}

/**
 * Check if a denial limit was exceeded and return an 'ask' result
 * so the user can review. Returns null if no limit was hit.
 */
export function handleDenialLimitExceeded(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  classifierReason: string,
  result: PermissionAskDecision,
  context: DenialStateContext,
): PermissionAskDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  const isHeadless = appState.toolPermissionContext.shouldAvoidPermissionPrompts
  // Capture counts before persistDenialState, which may mutate denialState
  // in-place via Object.assign for subagents with localDenialTracking.
  const totalCount = denialState.totalDenials
  const consecutiveCount = denialState.consecutiveDenials
  const warning = hitTotalLimit
    ? `${totalCount} actions were blocked this session. Please review the transcript before continuing.`
    : `${consecutiveCount} consecutive actions were blocked. Please review the transcript before continuing.`


  if (isHeadless) {
    throw new AbortError(
      'Agent aborted: too many classifier denials in headless mode',
    )
  }

  logForDebugging(
    `Classifier denial limit exceeded, falling back to prompting: ${warning}`,
    { level: 'warn' },
  )

  if (hitTotalLimit) {
    persistDenialState(context, {
      ...denialState,
      totalDenials: 0,
      consecutiveDenials: 0,
    })
  }

  // Preserve the original classifier value (e.g. 'dangerous-agent-action')
  // so downstream analytics in interactiveHandler can log the correct
  // user override event.
  const originalClassifier =
    result.decisionReason?.type === 'classifier'
      ? result.decisionReason.classifier
      : 'auto-mode'

  return {
    ...result,
    decisionReason: {
      type: 'classifier',
      classifier: originalClassifier,
      reason: `${warning}\n\nLatest blocked action: ${classifierReason}`,
    },
  }
}

/**
 * What a blocking classifier result becomes in auto mode. `ask` is the
 * decision the classifier stood in for, and the return type is the guarantee
 * a block rests on: this hands back that ask or a deny, never an allow —
 * denial.types.test.ts turns widening it into a type error. Throws AbortError
 * where headless has no one to ask and nothing to retry.
 */
export function decideClassifierBlock({
  classifierResult,
  ask,
  appState,
  denialState,
  context,
  toolName,
}: {
  classifierResult: Pick<
    YoloClassifierResult,
    | 'transcriptTooLong'
    | 'deterministic'
    | 'refused'
    | 'timedOut'
    | 'unavailable'
    | 'reason'
    | 'model'
  >
  ask: PermissionAskDecision
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  }
  denialState: DenialTrackingState
  context: DenialStateContext
  toolName: string
}): PermissionAskDecision | PermissionDenyDecision {
  // A block that is not a verdict on the action (classifierFallback)
  // skips iron_gate and falls back to normal prompting so the user can
  // approve/deny manually, rather than looping in fail-closed retries.
  const fallback = classifierFallback(classifierResult)
  if (fallback) {
    const { cause } = fallback
    if (!appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      logForDebugging(
        `Auto mode classifier ${cause}, falling back to normal permission handling`,
        { level: 'warn' },
      )
      return {
        ...ask,
        decisionReason: {
          type: 'other',
          reason: `Auto mode classifier ${cause} — falling back to manual approval`,
        },
      }
    }
    // Headless has no one to ask. A timeout falls through to the
    // unavailable branch below and keeps its retry guidance; a refusal
    // falls through to the ordinary denial, which counts toward the
    // denial limit like any block.
    if (fallback.abortsHeadless) {
      throw new AbortError(
        `Agent aborted: auto mode classifier ${cause} in headless mode`,
      )
    }
  }
  // When classifier is unavailable (API error), fail closed: deny with
  // retry guidance.
  if (classifierResult.unavailable) {
    logForDebugging(
      'Auto mode classifier unavailable, denying with retry guidance (fail closed)',
      { level: 'warn' },
    )
    return {
      behavior: 'deny',
      decisionReason: {
        type: 'classifier',
        classifier: 'auto-mode',
        reason: 'Classifier unavailable',
      },
      message: buildClassifierUnavailableMessage(
        toolName,
        classifierResult.model,
      ),
    }
  }

  // Update denial tracking and check limits
  const newDenialState = recordDenial(denialState)
  persistDenialState(context, newDenialState)

  logForDebugging(
    `Auto mode classifier blocked action: ${classifierResult.reason}`,
    { level: 'warn' },
  )

  // If denial limit hit, fall back to prompting so the user
  // can review. We check after the classifier so we can include
  // its reason in the prompt.
  const denialLimitResult = handleDenialLimitExceeded(
    newDenialState,
    appState,
    classifierResult.reason,
    ask,
    context,
  )
  if (denialLimitResult) {
    return denialLimitResult
  }

  return {
    behavior: 'deny',
    decisionReason: {
      type: 'classifier',
      classifier: 'auto-mode',
      reason: classifierResult.reason,
    },
    message: buildYoloRejectionMessage(classifierResult.reason),
  }
}
