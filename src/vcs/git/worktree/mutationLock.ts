/**
 * Serializes `git worktree add/remove` per repository root.
 *
 * The queue below is module-level MUTABLE state and, like the session
 * binding, must have exactly one owner: a second copy would let two callers
 * into `git worktree add` for the same repo at once, which is the index.lock
 * contention this guards against.
 */

/**
 * For each key, the promise that settles when the last holder queued so far
 * has left. A newcomer waits on it and puts its own exit in its place.
 */
const lastExitByRepo = new Map<string, Promise<void>>()

export async function withGitWorktreeMutationLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const turn = lastExitByRepo.get(repoRoot) ?? Promise.resolve()
  let leave: () => void = () => {}
  const exit = new Promise<void>(resolve => {
    leave = resolve
  })
  lastExitByRepo.set(repoRoot, exit)

  await turn
  try {
    return await fn()
  } finally {
    leave()
    // Forget the key only when nobody queued behind us.
    if (lastExitByRepo.get(repoRoot) === exit) lastExitByRepo.delete(repoRoot)
  }
}

export function _resetGitWorktreeMutationLocksForTesting(): void {
  lastExitByRepo.clear()
}
