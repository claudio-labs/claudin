import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}

/**
 * The session's working ROOT — for callers that must stay anchored to the same
 * directory for a whole session even as the shell wanders.
 *
 * Same as getCwd() except that a `cd` inside a Bash command does not move it:
 * Shell.ts's cwd tracking calls setCwd(), which only rewrites the cwd state,
 * while the transitions that really do re-root a session (worktree enter/exit,
 * resume, ssh/direct-connect) also call setOriginalCwd(). A cwd override still
 * wins, so a worktree-isolated sub-agent keeps its own root.
 */
export function getSessionRootCwd(): string {
  return cwdOverrideStorage.getStore() ?? getOriginalCwd()
}
