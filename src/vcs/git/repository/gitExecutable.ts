import { whichSync } from 'src/shared/proc/which.js'

/**
 * Looks git up at the first call and keeps that answer for the process; plain
 * `git` when the lookup finds nothing. The lookup is passed in so the keeping
 * can be tested without the machine's PATH.
 */
export function keepFirstGitLookup(find: () => string | null): () => string {
  let resolved: string | undefined
  return () => {
    resolved ??= find() ?? 'git'
    return resolved
  }
}

const gitOnPath = keepFirstGitLookup(() => whichSync('git'))

/** The absolute path of the git found on PATH at the first call, kept for the process. */
export function gitExe(): string {
  return gitOnPath()
}
