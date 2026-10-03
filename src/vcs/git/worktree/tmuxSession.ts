/**
 * The tmux side of worktrees: session naming, availability probing, and the
 * `--worktree --tmux` fast path that cli.tsx takes before the full CLI loads.
 */

import chalk from 'chalk'
import { basename } from 'path'
import { isInITerm2 } from 'src/agent/coordinator/swarm/backends/detection.js'
import { isInBundledMode } from 'src/platform/install/bundledMode.js'
import {
  executeWorktreeCreateHook,
  hasWorktreeCreateHook,
} from 'src/platform/lifecycleHooks/hooks.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getPlatform, type Platform } from 'src/shared/proc/platform.js'
import { findCanonicalGitRoot } from 'src/vcs/git/git.js'
import {
  getOrCreateWorktree,
  parsePRReference,
} from 'src/vcs/git/worktree/createWorktree.js'
import { performPostCreationSetup } from 'src/vcs/git/worktree/postCreationSetup.js'
import {
  validateWorktreeSlug,
  worktreeBranchName,
} from 'src/vcs/git/worktree/slugNaming.js'
import { exactSession, tmux, tmuxInForeground } from 'src/vcs/git/worktree/tmuxCommand.js'
import {
  inventWorktreeName,
  ITERM_TABS_TIP,
  readFastPathArgs,
  relaunchCommand,
  tmuxInstallHint,
  worktreeTarget,
  type Launch,
} from 'src/vcs/git/worktree/tmuxLaunch.js'

const SESSION_NAME_RESERVED = /[/.]/g

type FastPathAnswer = { handled: boolean; error?: string }

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  return `${basename(repoPath)}_${branch}`.replace(SESSION_NAME_RESERVED, '_')
}

export async function isTmuxAvailable(): Promise<boolean> {
  return (await tmux('-V')).ok
}

export function getTmuxInstallInstructions(): string {
  return tmuxInstallHint(getPlatform())
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const started = await tmux('new-session', '-d', '-s', sessionName, '-c', worktreePath)
  return started.ok ? { created: true } : { created: false, error: started.stderr.trim() }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  return (await tmux('kill-session', '-t', exactSession(sessionName))).ok
}

/**
 * The platform as `process.platform` says it now. getPlatform() is memoized
 * for the life of the process; it is asked only to tell WSL from Linux.
 */
function platformNow(): Platform {
  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    case 'linux':
      return getPlatform() === 'wsl' ? 'wsl' : 'linux'
    default:
      return 'unknown'
  }
}

function currentLaunch(): Launch {
  const script = process.argv[1]
  return { runtime: process.execPath, script: isInBundledMode() || !script ? null : script }
}

function refusal(message: string): FastPathAnswer {
  return { handled: false, error: `Error: ${message}` }
}

type Prepared = { worktreePath: string; repoName: string }

async function prepareWorktree(slug: string, prNumber: number | undefined): Promise<Prepared | FastPathAnswer> {
  const cwd = getCwd()
  const repoRoot = findCanonicalGitRoot(cwd)

  if (hasWorktreeCreateHook()) {
    try {
      const { worktreePath } = await executeWorktreeCreateHook(slug)
      console.log(`Using worktree from the WorktreeCreate hook: ${worktreePath}`)
      return { worktreePath, repoName: basename(repoRoot ?? cwd) }
    } catch (error) {
      return refusal(errorMessage(error))
    }
  }

  if (repoRoot === null) return refusal('--worktree requires a git repository (or a WorktreeCreate hook).')
  try {
    const made = await getOrCreateWorktree(repoRoot, slug, { prNumber })
    if (!made.existed) {
      console.log(`Created worktree ${made.worktreePath} from ${made.baseBranch}`)
      await performPostCreationSetup(repoRoot, made.worktreePath)
    }
    return { worktreePath: made.worktreePath, repoName: basename(repoRoot) }
  } catch (error) {
    return refusal(errorMessage(error))
  }
}

async function sessionExists(name: string): Promise<boolean> {
  return (await tmux('has-session', '-t', exactSession(name))).ok
}

/** Already inside tmux: start the session detached when needed, then move this client to it. */
async function switchInsideTmux(name: string, worktreePath: string, command: string[]): Promise<void> {
  if (!(await sessionExists(name))) {
    await tmux('new-session', '-d', '-s', name, '-c', worktreePath, '--', ...command)
  }
  await tmux('switch-client', '-t', exactSession(name))
}

/** From a plain terminal: attach in the foreground, creating the session when it is missing. */
async function attachFromTerminal(
  name: string,
  worktreePath: string,
  command: string[],
  classic: boolean,
): Promise<void> {
  const controlMode = !classic && isInITerm2()
  const exists = await sessionExists(name)
  if (controlMode && !exists) console.log(chalk.dim(ITERM_TABS_TIP))
  const client = controlMode ? ['-CC'] : []
  tmuxInForeground(
    exists
      ? [...client, 'attach-session', '-t', exactSession(name)]
      : [...client, 'new-session', '-s', name, '-c', worktreePath, '--', ...command],
  )
}

export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  if (process.platform === 'win32') return refusal('--tmux is not supported on Windows.')
  if (!(await isTmuxAvailable())) {
    return refusal(`tmux is not installed. ${tmuxInstallHint(platformNow())}`)
  }

  const parsed = readFastPathArgs(args)
  const named = parsed.name ?? inventWorktreeName()
  const { slug, prNumber } = worktreeTarget(named, parsePRReference(named))
  try {
    validateWorktreeSlug(slug)
  } catch (error) {
    return refusal(errorMessage(error))
  }

  const prepared = await prepareWorktree(slug, prNumber)
  if ('handled' in prepared) return prepared

  const sessionName = generateTmuxSessionName(prepared.repoName, worktreeBranchName(slug))
  const command = relaunchCommand(currentLaunch(), parsed.forwarded)
  if (process.env.TMUX) {
    await switchInsideTmux(sessionName, prepared.worktreePath, command)
  } else {
    // tmux's exit status is not ours to report: it prints its own errors.
    await attachFromTerminal(sessionName, prepared.worktreePath, command, parsed.classic)
  }
  return { handled: true }
}
