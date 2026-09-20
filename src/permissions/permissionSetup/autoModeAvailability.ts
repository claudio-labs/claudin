/**
 * The synchronous half of the auto-mode gate: is auto mode available at all,
 * and if not, why.
 *
 * `NO_CACHED_AUTO_MODE_CONFIG` is a sentinel whose IDENTITY is load-bearing —
 * it is how "not yet fetched" is told apart from "fetched and unset". It has
 * to exist in exactly one module; a second `Symbol()` would never compare
 * equal to this one and `getAutoModeEnabledStateIfCached` would start
 * answering 'enabled' on a cold start.
 */
import {
  getInitialSettings,
  hasAutoModeOptIn,
} from 'src/platform/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
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
 * with GrowthBook stubbed, tengu_iron_gate_closed defaults to fail-CLOSED,
 * so an incapable provider would deny-loop the session rather than degrade
 * gracefully. The probe itself runs lazily in verifyAutoModeGateAccess.
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

/**
 * The `enabled` field in the tengu_auto_mode_config GrowthBook JSON config.
 * Controls auto mode availability in UI surfaces (CLI, IDE, Desktop).
 * - 'enabled': auto mode is available in the shift-tab carousel (or equivalent)
 * - 'disabled': auto mode is fully unavailable — circuit breaker for incident response
 * - 'opt-in': auto mode is available only if the user has explicitly opted in
 *   (via --enable-auto-mode in CLI, or a settings toggle in IDE/Desktop)
 */
export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

// Claudin: GrowthBook is stubbed so the upstream config never resolves.
// Default to 'enabled' so the shift+tab carousel can reach auto mode out
// of the box. Users opt out with `disableAutoMode: 'disable'` in
// ~/.claudin/settings.json.
const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'enabled'

export function parseAutoModeEnabledState(value: unknown): AutoModeEnabledState {
  if (value === 'enabled' || value === 'disabled' || value === 'opt-in') {
    return value
  }
  return AUTO_MODE_ENABLED_DEFAULT
}

/**
 * Reads the `enabled` field from tengu_auto_mode_config (cached, may be stale).
 * Defaults to 'disabled' if GrowthBook is unavailable or the field is unset.
 * Other surfaces (IDE, Desktop) should call this to decide whether to surface
 * auto mode in their mode pickers.
 */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    enabled?: AutoModeEnabledState
  }>('tengu_auto_mode_config', {})
  return parseAutoModeEnabledState(config?.enabled)
}

const NO_CACHED_AUTO_MODE_CONFIG = Symbol('no-cached-auto-mode-config')

/**
 * Like getAutoModeEnabledState but returns undefined when no cached value
 * exists (cold start, before GrowthBook init). Used by the sync
 * circuit-breaker check in initialPermissionModeFromCLI, which must not
 * conflate "not yet fetched" with "fetched and disabled" — the former
 * defers to verifyAutoModeGateAccess, the latter blocks immediately.
 */
export function getAutoModeEnabledStateIfCached():
  | AutoModeEnabledState
  | undefined {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<
    { enabled?: AutoModeEnabledState } | typeof NO_CACHED_AUTO_MODE_CONFIG
  >('tengu_auto_mode_config', NO_CACHED_AUTO_MODE_CONFIG)
  if (config === NO_CACHED_AUTO_MODE_CONFIG) return undefined
  return parseAutoModeEnabledState(config?.enabled)
}

/**
 * Returns true if the user has opted in to auto mode via any trusted mechanism:
 * - CLI flag (--enable-auto-mode / --permission-mode auto) — session-scoped
 *   availability request; the startup dialog in showSetupScreens enforces
 *   persistent consent before the REPL renders.
 * - skipAutoPermissionPrompt setting (persistent; set by accepting the opt-in
 *   dialog or by IDE/Desktop settings toggle)
 */
export function hasAutoModeOptInAnySource(): boolean {
  if (autoModeStateModule?.getAutoModeFlagCli() ?? false) return true
  return hasAutoModeOptIn()
}
