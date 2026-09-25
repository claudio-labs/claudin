/**
 * The asynchronous auto-mode gate check, and the notification it produces.
 *
 * This is the only place that can fire a live classifier capability probe
 * against the active provider, which is why it is covered by a surface pin
 * rather than by behavioural tests.
 */
import { setNeedsAutoModeExitAttachment } from 'src/platform/bootstrap/state.js'
import { logForDebugging } from 'src/shared/debug.js'
import { modelSupportsAutoMode } from 'src/providers/transport/betas.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  getCachedClassifierProbe,
  getClassifierProbeKey,
  probeClassifierCapability,
} from 'src/permissions/classifierProbe.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import {
  autoModeAllowedForModel,
  isAutoModeDisabledBySettings,
} from 'src/permissions/permissionSetup/autoModeAvailability.js'
import { restoreDangerousPermissions } from 'src/permissions/permissionSetup/dangerousRuleStash.js'

export type AutoModeGateCheckResult = {
  // Transform function (not a pre-computed context) so callers can apply it
  // inside setAppState(prev => ...) against the CURRENT context. Pre-computing
  // the context here captured a stale snapshot: the async probe await below
  // can be outrun by a mid-turn shift-tab, and returning
  // { ...currentContext, ... } would overwrite the user's mode change.
  updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

export function getAutoModeUnavailableNotification(
  reason: AutoModeUnavailableReason,
): string {
  let base: string
  switch (reason) {
    case 'settings':
      base = 'auto mode disabled by settings'
      break
    case 'circuit-breaker':
      base = 'auto mode is unavailable for your plan'
      break
    case 'model':
      base = 'auto mode unavailable for this model'
      break
  }
  return base
}

/**
 * Async check of auto mode availability.
 *
 * Returns a transform function (not a pre-computed context) that callers
 * apply inside setAppState(prev => ...) against the CURRENT context. This
 * prevents the async probe await from clobbering mid-turn mode changes
 * (e.g., user shift-tabs to acceptEdits while this check is in flight).
 *
 * The transform re-checks mode/prePlanMode against the fresh ctx to avoid
 * kicking the user out of a mode they've already left during the await.
 */
export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
): Promise<AutoModeGateCheckResult> {
  // Runs in ALL builds (circuit breaker, carousel, kick-out) and is the
  // authoritative source for isAutoModeAvailable.
  const disabledBySettings = isAutoModeDisabledBySettings()
  // A settings disable latches the circuit breaker — blocks SDK/explicit
  // re-entry via isAutoModeGateEnabled().
  autoModeStateModule?.setAutoModeCircuitBroken(disabledBySettings)

  const mainModel = getMainLoopModel()
  // Non-Claude providers: lazily probe forced tool-choice capability once per
  // provider+baseUrl+model key. Claude models pass by name and never probe.
  // Only probe when a probe result could change the outcome (gate otherwise
  // open) and only when no result is cached — a cached failure is respected
  // until /provider doctor re-probes.
  if (!modelSupportsAutoMode(mainModel) && !disabledBySettings) {
    const provider = tryGetActiveProvider()
    if (provider) {
      const key = getClassifierProbeKey({
        provider: provider.transport,
        baseUrl: provider.baseUrl,
        model: mainModel,
      })
      if (!getCachedClassifierProbe(key)) {
        const result = await probeClassifierCapability({
          key,
          model: mainModel,
        })
        logForDebugging(
          `[auto-mode] classifier probe: model=${mainModel} ok=${result.ok} detail=${result.detail ?? ''}`,
        )
      }
    }
  }
  const modelSupported = autoModeAllowedForModel(mainModel)
  // canEnterAuto gates explicit entry (--permission-mode auto, defaultMode:
  // auto) on settings + model only.
  const canEnterAuto = !disabledBySettings && modelSupported
  // The carousel offers auto whenever it can be entered — no opt-in needed.
  const carouselAvailable = canEnterAuto
  logForDebugging(
    `[auto-mode] verifyAutoModeGateAccess: disabledBySettings=${disabledBySettings} model=${mainModel} modelSupported=${modelSupported} carouselAvailable=${carouselAvailable} canEnterAuto=${canEnterAuto}`,
  )

  // Capture CLI-flag intent now (doesn't depend on context).
  const autoModeFlagCli = autoModeStateModule?.getAutoModeFlagCli() ?? false

  // Return a transform function that re-evaluates context-dependent conditions
  // against the CURRENT context at setAppState time. The results above
  // (canEnterAuto, carouselAvailable, reason) are
  // closure-captured — those don't depend on context. But mode, prePlanMode,
  // and isAutoModeAvailable checks MUST use the fresh ctx or a mid-await
  // shift-tab gets reverted (or worse, the user stays in auto on a model that
  // failed the probe if they entered auto DURING the probe's await).
  const setAvailable = (
    ctx: ToolPermissionContext,
    available: boolean,
  ): ToolPermissionContext => {
    if (ctx.isAutoModeAvailable !== available) {
      logForDebugging(
        `[auto-mode] verifyAutoModeGateAccess setAvailable: ${ctx.isAutoModeAvailable} -> ${available}`,
      )
    }
    return ctx.isAutoModeAvailable === available
      ? ctx
      : { ...ctx, isAutoModeAvailable: available }
  }

  if (canEnterAuto) {
    return { updateContext: ctx => setAvailable(ctx, carouselAvailable) }
  }

  // Gate is off — determine reason (context-independent).
  let reason: AutoModeUnavailableReason
  if (disabledBySettings) {
    reason = 'settings'
    logForDebugging('auto mode disabled: disableAutoMode in settings', {
      level: 'warn',
    })
  } else {
    reason = 'model'
    logForDebugging(
      `auto mode disabled: model ${getMainLoopModel()} does not support auto mode`,
      { level: 'warn' },
    )
  }
  const notification = getAutoModeUnavailableNotification(reason)

  // Unified kick-out transform. Re-checks the FRESH ctx and only fires
  // side effects (setAutoModeActive(false), setNeedsAutoModeExitAttachment)
  // when the kick-out actually applies. This keeps autoModeActive in sync
  // with toolPermissionContext.mode even if the user changed modes during
  // the await: if they already left auto on their own, handleCycleMode
  // already deactivated the classifier and we don't fire again; if they
  // ENTERED auto during the await, we kick them out here.
  const kickOutOfAutoIfNeeded = (
    ctx: ToolPermissionContext,
  ): ToolPermissionContext => {
    const inAuto = ctx.mode === 'auto'
    logForDebugging(
      `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=${ctx.mode} ctx.prePlanMode=${ctx.prePlanMode} reason=${reason}`,
    )
    // Plan mode with auto active: either from prePlanMode='auto' (entered
    // from auto) or from opt-in (strippedDangerousRules present).
    const inPlanWithAutoActive =
      ctx.mode === 'plan' &&
      (ctx.prePlanMode === 'auto' || !!ctx.strippedDangerousRules)
    if (!inAuto && !inPlanWithAutoActive) {
      return setAvailable(ctx, false)
    }
    if (inAuto) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...applyPermissionUpdate(restoreDangerousPermissions(ctx), {
          type: 'setMode',
          mode: 'default',
          destination: 'session',
        }),
        isAutoModeAvailable: false,
      }
    }
    // Plan with auto active: deactivate auto, restore permissions, defuse
    // prePlanMode so ExitPlanMode goes to default.
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(ctx),
      prePlanMode: ctx.prePlanMode === 'auto' ? 'default' : ctx.prePlanMode,
      isAutoModeAvailable: false,
    }
  }

  // Notification decisions use the stale context — that's OK: we're deciding
  // WHETHER to notify based on what the user WAS doing when this check started.
  // (Side effects and mode mutation are decided inside the transform above,
  // against the fresh ctx.)
  const wasInAuto = currentContext.mode === 'auto'
  // Auto was used during plan: entered from auto or opt-in auto active
  const autoActiveDuringPlan =
    currentContext.mode === 'plan' &&
    (currentContext.prePlanMode === 'auto' ||
      !!currentContext.strippedDangerousRules)
  const wantedAuto = wasInAuto || autoActiveDuringPlan || autoModeFlagCli

  if (!wantedAuto) {
    // User didn't want auto at call time — no notification. But still apply
    // the full kick-out transform: if they shift-tabbed INTO auto during the
    // await, we need to evict them.
    return { updateContext: kickOutOfAutoIfNeeded }
  }

  if (wasInAuto || autoActiveDuringPlan) {
    // User was in auto or had auto active during plan — kick out + notify.
    return { updateContext: kickOutOfAutoIfNeeded, notification }
  }

  // autoModeFlagCli only: defaultMode was auto but sync check rejected it.
  // Suppress notification if isAutoModeAvailable is already false (already
  // notified on a prior check; prevents repeat notifications on successive
  // unsupported-model switches).
  return {
    updateContext: kickOutOfAutoIfNeeded,
    notification: currentContext.isAutoModeAvailable ? notification : undefined,
  }
}
