/**
 * The single `feature('TRANSCRIPT_CLASSIFIER')`-gated handle on autoModeState.
 *
 * Five of the permissionSetup modules read auto-mode state. This gate is
 * deliberately extracted ONCE and imported, never re-written per module:
 * `scripts/build/build.ts` folds `feature()` to a literal and then
 * dead-code-eliminates the losing branch, so a duplicated gate is a second
 * fold site that can disagree with this one — and no test can see it, because
 * under `bun test` every flag reads `false` and both branches resolve alike.
 *
 * Keep the shape exactly as it is: the gate call has to sit directly in an
 * `if` or a ternary condition, or it throws under `bun test`.
 */
import { feature } from 'bun:bundle'

/* eslint-disable @typescript-eslint/no-require-imports */
export const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/permissions/autoModeState.js') as typeof import('src/permissions/autoModeState.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
