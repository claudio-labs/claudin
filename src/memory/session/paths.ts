/**
 * Where a session's memory file lives: a `session-memory/` folder inside the
 * session's folder of the transcript directory for the working directory.
 *
 * Both are computed at call time, from the working directory (an agent's cwd
 * override included) and the active session id. The read permission and the
 * readers compute them the same way at the same moment, which is what keeps
 * them in agreement when either changes.
 */
import { join, sep } from 'path'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getCwd } from 'src/shared/fs/cwd.js'

const SESSION_MEMORY_FOLDER = 'session-memory'
const SESSION_MEMORY_FILE = 'summary.md'

/**
 * Ends with the path separator: the read permission grants everything that
 * starts with this string, and without it a sibling folder whose name merely
 * begins the same way would be granted too.
 */
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), SESSION_MEMORY_FOLDER) + sep
}

export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), SESSION_MEMORY_FILE)
}
