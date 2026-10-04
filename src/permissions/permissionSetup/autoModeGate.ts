/**
 * The asynchronous auto-mode gate check, and the notification it produces.
 *
 * This is the only place that can fire a live classifier capability probe
 * against the active provider.
 */
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import { modelSupportsAutoMode } from 'src/providers/transport/betas.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  getCachedClassifierProbe,
  getClassifierProbeKey,
  probeClassifierCapability,
} from 'src/permissions/classifierProbe.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import {
  getAutoModeUnavailableReason,
  isAutoModeDisabledBySettings,
} from 'src/permissions/permissionSetup/autoModeAvailability.js'
import { switchAutoOff } from 'src/permissions/permissionSetup/autoSession.js'

export type AutoModeGateCheckResult = {
  // A transform rather than a finished context: the probe is awaited, and a
  // mode change can land meanwhile, so the caller applies this to the context
  // it holds when the answer arrives.
  updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

const UNAVAILABLE_NOTICES: Readonly<Record<AutoModeUnavailableReason, string>> = {
  settings: 'auto mode disabled by settings',
  'circuit-breaker': 'auto mode is unavailable for your plan',
  model: 'auto mode unavailable for this model',
}

export function getAutoModeUnavailableNotification(
  reason: AutoModeUnavailableReason,
): string {
  return UNAVAILABLE_NOTICES[reason]
}

/**
 * Probes the session model once per provider endpoint. A model cleared by
 * name never needs it, and a stored answer (pass or fail) is final until
 * something clears the store.
 */
async function probeSessionModelIfUnknown(): Promise<void> {
  const model = getMainLoopModel()
  if (modelSupportsAutoMode(model)) return
  const provider = tryGetActiveProvider()
  if (!provider) return
  const key = getClassifierProbeKey({
    provider: provider.transport,
    baseUrl: provider.baseUrl,
    model,
  })
  if (getCachedClassifierProbe(key) !== undefined) return
  try {
    const outcome = await probeClassifierCapability({ key, model })
    logForDebugging(`[auto-mode] capability probe for ${model}: ${outcome.ok ? 'passed' : 'failed'}`)
  } catch (error) {
    logError(new Error('auto-mode gate: capability probe did not finish', { cause: error }))
  }
}

/** Plan mode that is running with auto: entered from auto, or holding its stash. */
function planBorrowsAuto(context: ToolPermissionContext): boolean {
  return (
    context.mode === 'plan' &&
    (context.prePlanMode === 'auto' || context.strippedDangerousRules !== undefined)
  )
}

function offerAuto(context: ToolPermissionContext): ToolPermissionContext {
  if (context.isAutoModeAvailable === true) return context
  return { ...context, isAutoModeAvailable: true }
}

function withdrawAuto(context: ToolPermissionContext): ToolPermissionContext {
  if (context.mode === 'auto') {
    return { ...switchAutoOff(context), mode: 'default', isAutoModeAvailable: false }
  }
  if (planBorrowsAuto(context)) {
    const prePlanMode = context.prePlanMode === 'auto' ? 'default' : context.prePlanMode
    return { ...switchAutoOff(context), prePlanMode, isAutoModeAvailable: false }
  }
  if (context.isAutoModeAvailable === false) return context
  return { ...context, isAutoModeAvailable: false }
}

/**
 * Whether the checked session wanted auto, and so deserves to hear why it
 * cannot have it. A startup request only counts while the context still
 * offered auto: once withdrawn, the user has already been told.
 */
function sessionWantedAuto(checked: ToolPermissionContext): boolean {
  if (checked.mode === 'auto' || planBorrowsAuto(checked)) return true
  const askedAtStartup = autoModeStateModule?.getAutoModeFlagCli() ?? false
  return askedAtStartup && checked.isAutoModeAvailable === true
}

export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  const disabledBySettings = isAutoModeDisabledBySettings()
  // In this fork only a settings disable latches the breaker, and a check
  // without it releases the breaker again.
  autoModeStateModule?.setAutoModeCircuitBroken(disabledBySettings)
  if (!disabledBySettings) await probeSessionModelIfUnknown()

  const reason = getAutoModeUnavailableReason()
  if (reason === null) return { updateContext: offerAuto }

  if (!sessionWantedAuto(currentContext)) return { updateContext: withdrawAuto }
  const shown: AutoModeUnavailableReason = reason === 'settings' ? 'settings' : 'model'
  return { updateContext: withdrawAuto, notification: UNAVAILABLE_NOTICES[shown] }
}
