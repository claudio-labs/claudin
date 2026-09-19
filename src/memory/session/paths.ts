/**
 * Where a session's memory lives on disk.
 *
 * These paths moved here from `src/permissions/filePermissions.ts`: the permissions
 * slice consumed them (to recognize a write to the session memory file) but did
 * not own them — session memory is this slice's domain.
 */
import { join, sep } from 'path'

import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'

/**
 * Returns the session memory directory path for the current session with trailing separator.
 * Path format: {projectDir}/{sessionId}/session-memory/
 */
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

/**
 * Returns the session memory file path for the current session.
 * Path format: {projectDir}/{sessionId}/session-memory/summary.md
 */
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}
