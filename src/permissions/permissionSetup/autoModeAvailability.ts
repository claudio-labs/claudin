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

/**
 * `disableAutoMode: "disable"` at the top level or under `permissions`, read
 * from the merged settings, so any layer can set it (a repository's included:
 * turning auto off only ever narrows what runs unasked).
 */
export function isAutoModeDisabledBySettings(): boolean {
  const merged = getInitialSettings()
  return (
    merged.disableAutoMode === 'disable' ||
    merged.permissions?.disableAutoMode === 'disable'
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
function autoModeAllowedForModel(model: string): boolean {
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

/** The three facts the gate is decided on, read once per question. */
type GateFacts = {
  disabledBySettings: boolean
  breakerLatched: boolean
  modelCleared: boolean
}

function readGateFacts(): GateFacts {
  const state = autoModeStateModule
  return {
    disabledBySettings: isAutoModeDisabledBySettings(),
    breakerLatched: state ? state.isAutoModeCircuitBroken() : false,
    // Without the classifier in the build no model is cleared, even one with a
    // stored passing probe.
    modelCleared: state ? autoModeAllowedForModel(getMainLoopModel()) : false,
  }
}

/** The first fact that closes the gate, in precedence order, or null. */
function firstClosingFact(facts: GateFacts): AutoModeUnavailableReason | null {
  if (facts.disabledBySettings) return 'settings'
  if (facts.breakerLatched) return 'circuit-breaker'
  if (!facts.modelCleared) return 'model'
  return null
}

export function isAutoModeGateEnabled(): boolean {
  return getAutoModeUnavailableReason() === null
}

export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  return firstClosingFact(readGateFacts())
}
