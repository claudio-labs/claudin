/**
 * The single source of truth for "which worktree is this session in".
 *
 * `currentWorktreeSession` is module-level MUTABLE state and must live in
 * exactly ONE module: two copies of the binding would mean two answers, and the
 * exit path (which removes a worktree) would then act on the wrong tree. Every
 * other module in worktree/ reads and writes it through the two accessors
 * below — none of them declares its own copy.
 */

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** How long worktree creation took (unset when resuming an existing worktree). */
  creationDurationMs?: number
  /** True if git sparse-checkout was applied via settings.worktree.sparsePaths. */
  usedSparsePaths?: boolean
  /**
   * True when the session entered a PRE-EXISTING worktree via EnterWorktree's
   * `path` parameter (not one we created). ExitWorktree must NOT remove an
   * attached worktree — it only chdir's back to the original directory.
   */
  attached?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/**
 * Restore the worktree session on --resume. The caller must have already
 * verified the directory exists (via process.chdir) and set the bootstrap
 * state (cwd, originalCwd).
 *
 * This is also the setter the sibling modules use when they enter or leave a
 * worktree, since the binding above is private to this file.
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}
