/**
 * Serializes `git worktree add/remove` per repository root.
 *
 * `gitWorktreeMutationLocks` is module-level MUTABLE state and, like the
 * session binding, must have exactly one owner — a second copy of the map
 * would let two callers into `git worktree add` for the same repo at once,
 * which is what the index.lock contention this guards against looks like.
 */

const gitWorktreeMutationLocks = new Map<string, Promise<void>>()

export async function withGitWorktreeMutationLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = gitWorktreeMutationLocks.get(repoRoot) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve
  })
  const next = previous.catch(() => {}).then(() => current)
  gitWorktreeMutationLocks.set(repoRoot, next)

  await previous.catch(() => {})

  try {
    return await fn()
  } finally {
    releaseCurrent()
    if (gitWorktreeMutationLocks.get(repoRoot) === next) {
      gitWorktreeMutationLocks.delete(repoRoot)
    }
  }
}

export function _resetGitWorktreeMutationLocksForTesting(): void {
  gitWorktreeMutationLocks.clear()
}
