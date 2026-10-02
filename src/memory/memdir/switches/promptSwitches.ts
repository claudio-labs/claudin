/**
 * Switches over the memory section of the system prompt. Read on every call.
 *
 *   CLAUDIN_MEMORY_PAST_CONTEXT  an off value (0, false, no, off) drops the past-context search
 *                                section, in both of its forms.
 */
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export function isPastContextSearchEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_MEMORY_PAST_CONTEXT)
}
