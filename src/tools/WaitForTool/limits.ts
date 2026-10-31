import { parseWholeNumberEnvVar } from 'src/shared/envValidation.js'

const DEFAULT_MAX_TIMEOUT_S = 1800

/** The longest one WaitFor call may wait, in seconds, as the environment says now (WaitForTool.ts). */
export function maxTimeoutS(): number {
  return parseWholeNumberEnvVar(
    'CLAUDIN_WAITFOR_MAX_TIMEOUT_S',
    process.env.CLAUDIN_WAITFOR_MAX_TIMEOUT_S,
    DEFAULT_MAX_TIMEOUT_S,
    1,
  )
}

/**
 * The cap the schema, the call form and the Bash sleep advice state: the one
 * set when this module loaded. One place, so a call any of them suggests
 * passes the schema.
 */
export const STATED_MAX_TIMEOUT_S = maxTimeoutS()
