import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { quote } from 'src/platform/bash/shellQuote.js'
import { getSessionIdFromLog } from 'src/sessions/sessionStorage.js'
import { CLI_COMMAND } from 'src/skills/bundled/shared/cliCommand.js'

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

export function checkCrossProjectResume(
  log: LogOption,
  showAllProjects: boolean,
  _worktreePaths: string[],
): CrossProjectResumeResult {
  const projectPath = log.projectPath
  if (!showAllProjects || !projectPath || projectPath === getOriginalCwd()) {
    return { isCrossProject: false }
  }
  // Sibling worktrees of this repository get the cd command too: resuming
  // one in place would point the conversation's paths at other files.
  const resume = quote([CLI_COMMAND, '--resume', String(getSessionIdFromLog(log))])
  return {
    isCrossProject: true,
    isSameRepoWorktree: false,
    projectPath,
    command: `cd ${quote([projectPath])} && ${resume}`,
  }
}
