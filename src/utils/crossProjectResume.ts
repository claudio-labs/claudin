import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { getSessionIdFromLog } from './sessionStorage.js'

export type CrossProjectResumeResult =
  | {
      isCrossProject: false
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: true
      projectPath: string
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: false
      command: string
      projectPath: string
    }

/**
 * Check if a log is from a different project directory and determine
 * whether it's a related worktree or a completely different project.
 *
 * For same-repo worktrees, we can resume directly without requiring cd.
 * For different projects, we generate the cd command.
 */
export function checkCrossProjectResume(
  log: LogOption,
  showAllProjects: boolean,
  _worktreePaths: string[],
): CrossProjectResumeResult {
  const currentCwd = getOriginalCwd()

  if (!showAllProjects || !log.projectPath || log.projectPath === currentCwd) {
    return { isCrossProject: false }
  }

  const sessionId = getSessionIdFromLog(log)
  const command = `cd ${quote([log.projectPath])} && claude --resume ${sessionId}`
  return {
    isCrossProject: true,
    isSameRepoWorktree: false,
    command,
    projectPath: log.projectPath,
  }
}
