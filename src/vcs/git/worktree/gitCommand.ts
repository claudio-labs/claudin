/**
 * The one way this unit runs git: by arguments and working directory, never
 * throwing, with the outcome reduced to what the callers branch on.
 */

import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { gitExe } from 'src/vcs/git/git.js'
import { GIT_NO_PROMPT_ENV } from 'src/vcs/git/noPromptEnv.js'

export type GitOutcome = { ok: boolean; stdout: string; stderr: string }

export async function git(cwd: string, ...args: string[]): Promise<GitOutcome> {
  const { code, stdout, stderr } = await execFileNoThrowWithCwd(gitExe(), args, { cwd })
  return { ok: code === 0, stdout, stderr }
}

/**
 * For commands that may talk to a remote: credentials are never asked for,
 * whatever the caller's environment says, and standard input is closed, so a
 * prompt can never hang the CLI.
 */
export async function gitWithoutPrompts(cwd: string, ...args: string[]): Promise<GitOutcome> {
  const { code, stdout, stderr } = await execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    env: { ...process.env, ...GIT_NO_PROMPT_ENV },
    stdin: 'ignore',
  })
  return { ok: code === 0, stdout, stderr }
}

/** git's complaint, for an error message. */
export function complaintOf(outcome: GitOutcome): string {
  return outcome.stderr.trim()
}
