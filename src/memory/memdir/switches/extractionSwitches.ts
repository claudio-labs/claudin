/**
 * The background extraction of memories. Read on every call.
 *
 *   CLAUDIN_EXTRACT_MEMORIES        an off value (0, false, no, off) disables it.
 *   CLAUDIN_EXTRACT_MEMORIES_EVERY  eligible turns between runs, read as a
 *                                   leading integer: default 15, at most 1000.
 */
import { getIsInteractive } from 'src/platform/bootstrap/state.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { validateBoundedIntEnvVar } from 'src/shared/envValidation.js'

const DEFAULT_TURN_INTERVAL = 15
const MAX_TURN_INTERVAL = 1000

export function isExtractMemoriesEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_EXTRACT_MEMORIES)
}

/** Callers also check the EXTRACT_MEMORIES build flag and auto memory itself. */
export function isExtractModeActive(): boolean {
  return isExtractMemoriesEnabled() && getIsInteractive()
}

export function getExtractionTurnInterval(): number {
  return validateBoundedIntEnvVar(
    'CLAUDIN_EXTRACT_MEMORIES_EVERY',
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY,
    DEFAULT_TURN_INTERVAL,
    MAX_TURN_INTERVAL,
  ).effective
}
