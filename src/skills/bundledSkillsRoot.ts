/**
 * The directory bundled skills extract their reference files into.
 *
 * A leaf on purpose: the permission layer imports it to allowlist reads under
 * the root, and must not pull the skill registry or the tool types in with it.
 */
import { randomBytes } from 'crypto'
import { join } from 'path'

import { getClaudeTempDir } from 'src/platform/tmpdir.js'

declare const MACRO: { VERSION: string }

const NONCE_BYTES = 16

let root: string | undefined

/**
 * `<per-user temp dir>/bundled-skills/<version>/<nonce>`, the same path for
 * the life of the process.
 *
 * SECURITY: the nonce is what makes the allowlist safe. The temp dir, the uid
 * in its name and the version are all public, so on a shared /tmp another
 * local user could create the rest of the path first and plant files in it.
 * 128 bits drawn once per process put the path out of their reach. Memoized
 * by hand rather than with lodash's memoize, whose exposed cache could be
 * cleared and move the root out from under files already written.
 */
export function getBundledSkillsRoot(): string {
  root ??= join(
    getClaudeTempDir(),
    'bundled-skills',
    MACRO.VERSION,
    randomBytes(NONCE_BYTES).toString('hex'),
  )
  return root
}
