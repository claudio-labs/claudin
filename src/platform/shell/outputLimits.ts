import { validateBoundedIntEnvVar } from 'src/shared/envValidation.js'

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000
/**
 * The shells' persistence line (Bash, PowerShell): a result past it is saved
 * and paged. Not the env-raisable stdout cap above, which only bounds what a
 * run keeps in memory.
 */
export const SHELL_RESULT_MAX_CHARS = 30_000

export function getMaxOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}
