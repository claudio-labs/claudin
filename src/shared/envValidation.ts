import { logForDebugging } from 'src/shared/debug.js'

const WHOLE_NUMBER_RE = /^\d+$/

export type EnvVarValidationResult = {
  effective: number
  status: 'valid' | 'capped' | 'invalid'
  message?: string
}

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  if (!value) {
    return { effective: defaultValue, status: 'valid' }
  }
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed <= 0) {
    const result: EnvVarValidationResult = {
      effective: defaultValue,
      status: 'invalid',
      message: `Invalid value "${value}" (using default: ${defaultValue})`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  if (parsed > upperLimit) {
    const result: EnvVarValidationResult = {
      effective: upperLimit,
      status: 'capped',
      message: `Capped from ${parsed} to ${upperLimit}`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  return { effective: parsed, status: 'valid' }
}

/**
 * A whole-number env var read strictly: digits only, and at least `min`.
 * Anything else falls back to the default. parseInt would read `600s` as 600
 * and `abc` as NaN, and both reached the SDK as a timeout or a retry count.
 */
export function parseWholeNumberEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  min = 0,
): number {
  if (!value) return defaultValue
  const trimmed = value.trim()
  const parsed = WHOLE_NUMBER_RE.test(trimmed) ? Number(trimmed) : NaN
  if (Number.isSafeInteger(parsed) && parsed >= min) return parsed
  logForDebugging(`${name} Invalid value "${value}" (using default: ${defaultValue})`)
  return defaultValue
}
