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
  creationDurationMs?: number
  usedSparsePaths?: boolean
  /**
   * True when the session entered a PRE-EXISTING worktree via EnterWorktree's
   * `path` parameter (not one we created). ExitWorktree must NOT remove an
   * attached worktree — it only chdir's back to the original directory.
   */
  attached?: boolean
}

/** The published session, kept by reference: readers get the very object. */
const binding: { session: WorktreeSession | null } = { session: null }

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return binding.session
}

export function restoreWorktreeSession(session: WorktreeSession | null): void {
  binding.session = session
}
