/**
 * The persistence switch every write path consults. Read at call time:
 * tests and `/config` change its inputs between calls.
 */
import { isSessionPersistenceDisabled } from 'src/platform/bootstrap/state.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

/**
 * The switches a user turns persistence off with: `--no-session-persistence`,
 * `cleanupPeriodDays: 0` and `CLAUDIN_SKIP_PROMPT_HISTORY`. Metadata writes
 * honour these (finding 2).
 */
export function isPersistenceDisabledByUser(): boolean {
  return (
    isSessionPersistenceDisabled() ||
    getInitialSettings().cleanupPeriodDays === 0 ||
    isEnvTruthy(process.env.CLAUDIN_SKIP_PROMPT_HISTORY)
  )
}

/**
 * Whether messages and side entries are kept out of the disk. Under
 * `NODE_ENV=test` they are too, unless a suite opts in, so that unit tests do
 * not fill the config home with transcripts.
 */
export function isPersistenceOff(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  const mutedForTests = nodeEnv === 'test' && !isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)
  return mutedForTests || isPersistenceDisabledByUser()
}
