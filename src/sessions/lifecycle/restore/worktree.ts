/**
 * Taking a resumed session back into the worktree it was in, and out again.
 */
import { getCwdState, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { dropDirectoryCaches } from 'src/sessions/lifecycle/restore/directoryCaches.js'
import { saveWorktreeState } from 'src/sessions/sessionStorage.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import type { PersistedWorktreeSession } from 'src/shared/types/logs.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from 'src/vcs/git/worktree.js'

export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const createdThisRun = getCurrentWorktreeSession()
  if (createdThisRun) {
    // The metadata restore has just recorded the transcript's worktree over this run's own.
    saveWorktreeState(createdThisRun)
    return
  }
  if (!worktreeSession) return
  if (!enterDirectory(worktreeSession.worktreePath)) {
    // Recorded as exited, so that the next resume does not try again.
    saveWorktreeState(null)
    return
  }
  restoreWorktreeSession(worktreeSession)
  dropDirectoryCaches()
}

/**
 * Leave the worktree a resume entered. The recorded worktree state is left as
 * it is: the callers clear or replace the session's metadata next.
 */
export function exitRestoredWorktree(): void {
  const originalCwd = getCurrentWorktreeSession()?.originalCwd
  if (originalCwd === undefined) return
  restoreWorktreeSession(null)
  dropDirectoryCaches()
  enterDirectory(originalCwd)
}

/**
 * Move the process, the cwd and the original cwd into `dir`, by its real
 * path. The project root stays where it is, so that skills and history keep
 * to the project the session started in. False, with nothing moved, when the
 * directory cannot be entered.
 */
function enterDirectory(dir: string): boolean {
  try {
    process.chdir(dir)
  } catch (error) {
    logForDebugging(`Staying in the current directory: cannot enter ${dir}: ${errorMessage(error)}`)
    return false
  }
  setCwd(dir)
  setOriginalCwd(getCwdState())
  return true
}
