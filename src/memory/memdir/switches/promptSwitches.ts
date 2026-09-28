/**
 * Switches over the memory section of the system prompt. Read on every call.
 *
 *   CLAUDIN_LEAN_MEMORY_PROMPT   an off value (0, false, no, off) ships the
 *                                full text instead of the lean one.
 *   CLAUDIN_MEMORY_PAST_CONTEXT  an off value drops the past-context search
 *                                section, in both of its forms.
 */
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export function isLeanMemoryPromptEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_LEAN_MEMORY_PROMPT)
}

export function isPastContextSearchEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_MEMORY_PAST_CONTEXT)
}
