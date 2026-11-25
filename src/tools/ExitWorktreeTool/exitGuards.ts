/**
 * ExitWorktree's own logic, apart from the tool so it is testable without a
 * worktree: what a `remove` result says it removed, and the two things that
 * stop a `remove` because something may still be working in the worktree.
 */
import type { TaskState } from 'src/agent/tasks/types.js'
import { isBackgroundWork } from 'src/agent/tasks/types.js'
import { pathInWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'
import type { LiveSession } from 'src/sessions/concurrentSessions.js'
import type { WorktreeCleanup } from 'src/vcs/git/worktree.js'

/** The other live sessions whose cwd is the worktree or inside it. */
export function sessionsInWorktree(
  sessions: readonly LiveSession[],
  worktreePath: string,
): LiveSession[] {
  return sessions.filter(s => pathInWorkingPath(s.cwd, worktreePath))
}

/**
 * This session's background work started at or after `sinceMs`, the moment
 * it entered the worktree: tasks carry no cwd, so that is the work that may
 * be running inside it. MCP servers and containers are not counted, as in
 * isBackgroundWork.
 */
export function tasksStartedSince(
  tasks: Readonly<Record<string, TaskState>>,
  sinceMs: number,
): TaskState[] {
  return Object.values(tasks).filter(t => isBackgroundWork(t) && t.startTime >= sinceMs)
}

/** Refused even with discard_changes: only that session's user can end it. */
export function sessionInWorktreeRefusal(
  sessions: readonly LiveSession[],
  worktreePath: string,
): string {
  const which = sessions.map(s => `pid ${s.pid}`).join(', ')
  const another = sessions.length === 1 ? 'Another Claudin session' : `${sessions.length} other Claudin sessions`
  const verb = sessions.length === 1 ? 'is' : 'are'
  return `${another} (${which}) ${verb} running in this worktree, though possibly idle, so this tool will not remove ${worktreePath}, even with discard_changes. If the user ends ${sessions.length === 1 ? 'that session' : 'those sessions'}, call this tool again. Otherwise use action: "keep".`
}

/** Refused unless discard_changes, which removes the worktree under them. */
export function tasksInWorktreeRefusal(tasks: readonly TaskState[]): string {
  const one = tasks.length === 1
  const list = tasks.map(t => `"${t.description}"`).join(', ')
  const them = one ? 'it' : 'them'
  return `${one ? 'A background task' : `${tasks.length} background tasks`} started in this worktree may still be running there (${list}). Wait for ${them}, or ask the user before stopping ${them}, then call this tool again — or use action: "keep". discard_changes: true removes the worktree under ${them}.`
}

/**
 * The first sentence of a `remove` result. It names only what is gone: a
 * worktree a hook made is removed by a WorktreeRemove hook or not at all,
 * and a branch git refuses to delete stays.
 */
export function describeRemoval({
  worktreePath,
  worktreeBranch,
  hookBased,
  cleanup,
}: {
  worktreePath: string
  worktreeBranch?: string
  hookBased?: boolean
  cleanup: WorktreeCleanup
}): string {
  if (!cleanup.removed) {
    const why = hookBased
      ? 'a hook made this worktree, and no WorktreeRemove hook is configured to remove it'
      : `git could not remove it${cleanup.removeError ? ` (${cleanup.removeError})` : ''}`
    return `Exited the worktree, but ${worktreePath} is still on disk: ${why}.`
  }
  if (cleanup.branch === 'deleted') {
    return `Exited and removed worktree at ${worktreePath} and deleted its branch ${worktreeBranch}.`
  }
  if (cleanup.branch === 'refused') {
    return `Exited and removed worktree at ${worktreePath}. Git refused to delete branch ${worktreeBranch}, so it is still there${cleanup.branchError ? `: ${cleanup.branchError}` : '.'}`
  }
  const hookNote = hookBased ? ' A hook made it, so any branch it has was left to the hook.' : ''
  return `Exited and removed worktree at ${worktreePath}.${hookNote}`
}
