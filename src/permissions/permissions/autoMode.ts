/**
 * Auto mode: settling an ask without a person, where that is safe.
 *
 * The classifier and its allowlist arrive as `AutoModeDeps`, loaded when a
 * decision needs them (`loadAutoModeDeps`) rather than when this module
 * loads. Loading them eagerly read the classifier's tool name while the
 * classifier module could still be mid-initialisation, a cycle that broke
 * any run that imported the classifier first.
 */
import { feature } from 'bun:bundle'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import { getToolNameForPermissionCheck } from 'src/mcp/mcpStringUtils.js'
import { AbortError } from 'src/shared/errors.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type { YoloClassifierResult } from 'src/shared/types/permissions.js'
import { addToTurnClassifierDuration } from 'src/platform/bootstrap/state.js'
import {
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
} from 'src/agent/messages/rejection.js'
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDenyDecision,
} from 'src/permissions/PermissionResult.js'
import type {
  classifyYoloAction,
  formatActionForClassifier,
} from 'src/permissions/yoloClassifier.js'
import type {
  isAutoModeAllowlistedReadOnlyToolUse,
  isAutoModeAllowlistedTool,
} from 'src/permissions/classifierDecision.js'
import type { isAutoModeActive } from 'src/permissions/autoModeState.js'
import {
  clearClassifierChecking,
  setClassifierChecking,
} from 'src/permissions/classifierApprovals.js'
import { recordDenial } from 'src/permissions/denialTracking.js'
import {
  currentDenialState,
  handleDenialLimitExceeded,
  persistDenialState,
} from 'src/permissions/permissions/denial.js'
import {
  askTool,
  contextShowingMode,
  type ParsedInput,
  readsOnly,
} from 'src/permissions/permissions/toolVerdict.js'

export type AutoModeDeps = {
  classify: typeof classifyYoloAction
  describeAction: typeof formatActionForClassifier
  /** Built-in tools that never need the classifier. Given a permission name. */
  isSafeTool: typeof isAutoModeAllowlistedTool
  /** Built-in tools that skip the classifier only for a call that reads. */
  isSafeWhenReading: typeof isAutoModeAllowlistedReadOnlyToolUse
}

/** An ask auto mode has to settle, with what it needs to settle it. */
export type AutoModeAsk = {
  tool: Tool
  input: Record<string, unknown>
  parsed: ParsedInput
  context: ToolUseContext
  assistantMessage: AssistantMessage
  toolUseID: string
  ask: PermissionAskDecision
  /** Whether to ask the tool again as acceptEdits mode would. */
  acceptEditsMayAllow: boolean
}

const AUTO_MODE = 'auto-mode'
const UNAVAILABLE_REASON = 'Classifier unavailable'

export function loadAutoModeDeps(): AutoModeDeps | null {
  const modules = feature('TRANSCRIPT_CLASSIFIER')
    ? {
        classifier: require('src/permissions/yoloClassifier.js') as typeof import('src/permissions/yoloClassifier.js'),
        allowlist: require('src/permissions/classifierDecision.js') as typeof import('src/permissions/classifierDecision.js'),
      }
    : null
  if (modules === null) return null
  return {
    classify: modules.classifier.classifyYoloAction,
    describeAction: modules.classifier.formatActionForClassifier,
    isSafeTool: modules.allowlist.isAutoModeAllowlistedTool,
    isSafeWhenReading: modules.allowlist.isAutoModeAllowlistedReadOnlyToolUse,
  }
}

/** The auto-mode switch, or null in a build without auto mode. */
export function loadAutoModeState(): { isAutoModeActive: typeof isAutoModeActive } | null {
  return feature('TRANSCRIPT_CLASSIFIER')
    ? (require('src/permissions/autoModeState.js') as typeof import('src/permissions/autoModeState.js'))
    : null
}

function noOneToAsk(context: ToolUseContext): boolean {
  return context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts === true
}

function refusedForLackOfAPerson(message: string, reason: string): PermissionDenyDecision {
  return { behavior: 'deny', message, decisionReason: { type: 'asyncAgent', reason } }
}

function allowedByAutoMode(updatedInput: Record<string, unknown>): PermissionAllowDecision {
  return { behavior: 'allow', updatedInput, decisionReason: { type: 'mode', mode: 'auto' } }
}

function onlyAPersonMayApprove(ask: PermissionAskDecision): boolean {
  const reason = ask.decisionReason
  return reason?.type === 'safetyCheck' && reason.classifierApprovable !== true
}

async function allowedUnderAcceptEdits(call: AutoModeAsk): Promise<PermissionAllowDecision | null> {
  const verdict = await askTool(call.tool, call.parsed, contextShowingMode(call.context, 'acceptEdits'))
  if (verdict.behavior !== 'allow') return null
  return allowedByAutoMode(verdict.updatedInput ?? call.input)
}

/**
 * Checked against the permission name, so an MCP tool that borrows a
 * built-in's name (`Read`, `classify_result`) is not mistaken for it.
 */
function safeWithoutClassifier(call: AutoModeAsk, deps: AutoModeDeps): boolean {
  const name = getToolNameForPermissionCheck(call.tool)
  return (
    deps.isSafeTool(name) ||
    deps.isSafeWhenReading(name, () => readsOnly(call.tool, call.parsed))
  )
}

function handBackToUser(ask: PermissionAskDecision, cause: string): PermissionAskDecision {
  return {
    ...ask,
    decisionReason: {
      type: 'other',
      reason: `Auto mode classifier could not decide because ${cause}, so this call falls back to manual approval`,
    },
  }
}

function classifierUnavailable(toolName: string, model: string): PermissionDenyDecision {
  return {
    behavior: 'deny',
    decisionReason: { type: 'classifier', classifier: AUTO_MODE, reason: UNAVAILABLE_REASON },
    message: buildClassifierUnavailableMessage(toolName, model),
  }
}

function permanentFailureCause(result: YoloClassifierResult): string | null {
  if (result.transcriptTooLong) return 'the transcript does not fit its context window'
  if (result.deterministic) return 'its request failed with a deterministic error'
  return null
}

function classifierBlocked(call: AutoModeAsk, reason: string): PermissionDecision {
  const streak = recordDenial(currentDenialState(call.context))
  persistDenialState(call.context, streak)
  const handedBack = handleDenialLimitExceeded(
    streak,
    call.context.getAppState(),
    reason,
    call.assistantMessage,
    call.tool,
    call.ask,
    call.context,
  )
  return (
    handedBack ?? {
      behavior: 'deny',
      decisionReason: { type: 'classifier', classifier: AUTO_MODE, reason },
      message: buildYoloRejectionMessage(reason),
    }
  )
}

function readClassifierResult(call: AutoModeAsk, result: YoloClassifierResult): PermissionDecision {
  const headless = noOneToAsk(call.context)
  const permanent = permanentFailureCause(result)
  if (permanent !== null) {
    if (headless) {
      throw new AbortError(`The auto mode classifier failed in headless mode because ${permanent}`)
    }
    return handBackToUser(call.ask, permanent)
  }
  // Running out of time is transient: a person can decide now, and a
  // headless agent gets the unavailable message that tells it to retry.
  if (result.timedOut && !headless) return handBackToUser(call.ask, 'it ran out of its time budget')
  if (result.unavailable || result.timedOut) return classifierUnavailable(call.tool.name, result.model)
  if (result.shouldBlock) return classifierBlocked(call, result.reason)
  return {
    behavior: 'allow',
    updatedInput: call.input,
    decisionReason: { type: 'classifier', classifier: AUTO_MODE, reason: result.reason },
  }
}

async function consultClassifier(call: AutoModeAsk, deps: AutoModeDeps): Promise<PermissionDecision> {
  const { context, toolUseID } = call
  setClassifierChecking(toolUseID)
  let result: YoloClassifierResult
  try {
    result = await deps.classify(
      context.messages,
      deps.describeAction(call.tool.name, call.input),
      context.options.tools,
      context.getAppState().toolPermissionContext,
      context.abortController.signal,
    )
  } finally {
    clearClassifierChecking(toolUseID)
  }
  if (result.durationMs !== undefined) addToTurnClassifierDuration(result.durationMs)
  return readClassifierResult(call, result)
}

/**
 * In order: what only a person may approve stays an ask (or is refused where
 * no one can be asked); then what acceptEdits would allow, the safe tools,
 * and finally the classifier.
 */
export async function settleAutoModeAsk(
  call: AutoModeAsk,
  deps: AutoModeDeps,
): Promise<PermissionDecision> {
  const { ask, tool } = call
  if (onlyAPersonMayApprove(ask)) {
    if (!noOneToAsk(call.context)) return ask
    const reason =
      ask.decisionReason?.type === 'safetyCheck' ? ask.decisionReason.reason : ask.message
    return refusedForLackOfAPerson(
      ask.message,
      `This safety check needs interactive approval, which is not available here: ${reason}`,
    )
  }
  if (tool.requiresUserInteraction?.()) return ask
  if (tool.name === POWERSHELL_TOOL_NAME) {
    if (!noOneToAsk(call.context)) return ask
    const why = `${POWERSHELL_TOOL_NAME} commands require interactive approval in auto mode, and no one can approve them here.`
    return refusedForLackOfAPerson(why, why)
  }
  if (call.acceptEditsMayAllow) {
    const allowed = await allowedUnderAcceptEdits(call)
    if (allowed) return allowed
  }
  if (safeWithoutClassifier(call, deps)) return allowedByAutoMode(call.input)
  return consultClassifier(call, deps)
}
