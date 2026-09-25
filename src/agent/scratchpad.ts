/**
 * The per-session scratchpad directory the agent writes temporary files to.
 *
 * Moved here from `src/permissions/filePermissions.ts`: three of the four callers
 * are in this slice (the system prompt, the query engine and the REPL's query
 * controller), and the fourth only creates the directory at boot. Permission
 * checking consumes the path to allowlist writes into it; it does not own it.
 */
import { join } from 'path'

import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

/**
 * Checks if the scratchpad directory feature is enabled.
 * The scratchpad is a per-session directory for Claude to write temporary files.
 *
 * On by default in this fork; upstream shipped it off. The system prompt
 * names the directory and `checkEditableInternalPath` lets Write reach it
 * without a prompt, so plan-mode research has somewhere to put a throwaway
 * script: `/tmp` is outside the working tree, where a Write is an 'ask' that
 * plan mode hard-denies (108 plan-mode Bash denials in 2026-09-14..20 were
 * that). CLAUDIN_SCRATCHPAD=0 is the killswitch. It must not change while the
 * process lives — the system prompt names the directory.
 */
export function isScratchpadEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_SCRATCHPAD)
}

/**
 * Returns the scratchpad directory path for the current session.
 * Path format: /tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/
 */
export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

/**
 * Ensures the scratchpad directory exists for the current session.
 * Creates the directory with secure permissions (0o700) if it doesn't exist.
 * Returns the path to the scratchpad directory.
 * @throws If scratchpad feature is not enabled
 */
export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()

  // Create directory recursively with secure permissions (owner-only access)
  // FsOperations.mkdir handles recursive: true internally and is a no-op if dir exists
  await fs.mkdir(scratchpadDir, { mode: 0o700 })

  return scratchpadDir
}
