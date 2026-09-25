/**
 * The synchronous half of the auto-mode gate: is auto mode available at all,
 * and if not, why.
 */
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { modelSupportsAutoMode } from 'src/providers/transport/betas.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  getCachedClassifierProbe,
  getClassifierProbeKey,
} from 'src/permissions/classifierProbe.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
// Type-only, so it is erased before runtime and creates no import cycle with
// autoModeGate.ts, which imports the predicates below.
import type { AutoModeUnavailableReason } from 'src/permissions/permissionSetup/autoModeGate.js'

export function isAutoModeDisabledBySettings(): boolean {
  const settings = getInitialSettings() || {}
  return (
    (settings as { disableAutoMode?: 'disable' }).disableAutoMode ===
      'disable' ||
    (settings.permissions as { disableAutoMode?: 'disable' } | undefined)
      ?.disableAutoMode === 'disable'
  )
}

/**
 * Sync model check for the auto-mode gate. Claude models (4.6+/5.x) pass by
 * canonical name. Everything else reaches the API through the openaiShim
 * tool-choice translation, which is only trusted after the capability probe
 * (classifierProbe.ts) has passed for this provider+baseUrl+model key —
 * the classifier fails CLOSED, so an incapable provider would deny-loop the
 * session rather than degrade gracefully. The probe itself runs lazily in
 * verifyAutoModeGateAccess.
 */
export function autoModeAllowedForModel(model: string): boolean {
  if (modelSupportsAutoMode(model)) return true
  const provider = tryGetActiveProvider()
  if (!provider) return false
  const key = getClassifierProbeKey({
    provider: provider.transport,
    baseUrl: provider.baseUrl,
    model,
  })
  return getCachedClassifierProbe(key)?.ok === true
}

/** @internal - test-only: exercise the sync gate predicate directly */
export function __autoModeAllowedForModelForTests(model: string): boolean {
  return autoModeAllowedForModel(model)
}

/**
 * Checks if auto mode can be entered: circuit breaker is not active and settings
 * have not disabled it. Synchronous.
 */
export function isAutoModeGateEnabled(): boolean {
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) return false
  if (isAutoModeDisabledBySettings()) return false
  if (!autoModeAllowedForModel(getMainLoopModel())) return false
  return true
}

/**
 * Returns the reason auto mode is currently unavailable, or null if available.
 * Synchronous — uses state populated by verifyAutoModeGateAccess.
 */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return 'circuit-breaker'
  }
  if (!autoModeAllowedForModel(getMainLoopModel())) return 'model'
  return null
}
