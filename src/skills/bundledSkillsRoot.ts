/**
 * Where bundled skills are extracted on disk.
 *
 * A leaf module on purpose: both `bundledSkills.ts` (which writes there) and
 * the permissions slice (which allowlists reads from there) need this path,
 * and routing the permission check through the full bundledSkills module
 * would drag `src/tools/Tool.js` into it. Moved here from
 * `src/permissions/filesystem.ts` — the skills slice owns the location of its
 * own extraction tree.
 */
import { randomBytes } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'

import { getClaudeTempDir } from 'src/platform/tmpdir.js'

declare const MACRO: { VERSION: string }

/**
 * Root for bundled-skill file extraction (see bundledSkills.ts).
 *
 * SECURITY: The per-process random nonce is the load-bearing defense here.
 * Every other path component (uid, VERSION, skill name, file keys) is public
 * knowledge, so without it a local attacker can pre-create the tree on a
 * shared /tmp — sticky bit prevents deletion, not creation — and either
 * symlink an intermediate directory (O_NOFOLLOW only checks the final
 * component) or own a parent dir and swap file contents post-write for prompt
 * injection via the read allowlist. diskOutput.ts gets the same property from
 * the session-ID UUID in its path.
 *
 * Memoized so the extraction writes and the permission check agree on the
 * path for the life of the process. Version-scoped so stale extractions from
 * other binaries don't fall under the allowlist.
 */
export const getBundledSkillsRoot = memoize(
  function getBundledSkillsRoot(): string {
    const nonce = randomBytes(16).toString('hex')
    return join(getClaudeTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
  },
)
