import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'

/**
 * Whether inference-config commands (/model, /fast, /effort) should execute
 * immediately (during a running query) rather than waiting for the current
 * turn to finish.
 *
 * Always enabled for ants; gated by experiment for external users.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_immediate_model_command',
    false,
  )
}
