/**
 * Entering, leaving and sweeping worktrees — everything that reads or clears
 * the session recorded by createWorktree.
 *
 * The session binding itself lives in session.ts; this module only reaches it
 * through getCurrentWorktreeSession/restoreWorktreeSession, which is what keeps
 * the "which tree am I in" answer single-valued on the removal path.
 */

import { readdir, realpath, stat } from 'fs/promises'
import { basename, join } from 'path'
import { saveCurrentProjectConfig } from 'src/platform/config/config.js'
import { executeWorktreeRemoveHook } from 'src/platform/lifecycleHooks/hooks.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { sleep } from 'src/shared/sleep.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  gitExe,
} from 'src/vcs/git/git.js'
import { readWorktreeHeadSha } from 'src/vcs/git/gitFilesystem.js'
import { removeAgentWorktree } from 'src/vcs/git/worktree/createWorktree.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree/session.js'
import {
  worktreeBranchName,
  worktreesDir,
} from 'src/vcs/git/worktree/slugNaming.js'

/**
 * Normalize a path for comparison, resolving symlinks when the path exists.
 * Falls back to the raw path if realpath fails (e.g. path doesn't exist).
 */
async function normalizePath(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

/**
 * Enter a PRE-EXISTING git worktree (e.g. one created by `git worktree add`)
 * instead of creating a new one. The path must be a registered worktree of the
 * current repository (it must appear in `git worktree list`); the main worktree
 * itself is rejected. The resulting session is marked `attached: true` so
 * ExitWorktree never removes it.
 */
export async function attachExistingWorktree(
  path: string,
  sessionId: string,
): Promise<WorktreeSession> {
  const gitRoot = findGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error('Cannot enter a worktree: not in a git repository.')
  }

  const targetPath = await normalizePath(path)

  // Enumerate registered worktrees of this repo. Use `-z` (NUL-delimited): the
  // plain `--porcelain` form does NOT quote paths, so a path containing a
  // newline would be split mid-value. With `-z` every attribute line is
  // NUL-terminated, so a `worktree <path>` value can hold any byte except NUL.
  // The FIRST `worktree` entry is always the main worktree.
  const { code, stdout, stderr } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain', '-z'],
    { cwd: gitRoot },
  )
  if (code !== 0) {
    throw new Error(`Failed to list worktrees: ${stderr.trim()}`)
  }

  // Don't trim the path value — a leading/trailing space can be a real path
  // char, and the NUL split already stripped the terminator.
  const listedPaths = stdout
    .split('\0')
    .filter(field => field.startsWith('worktree '))
    .map(field => field.slice('worktree '.length))
  const normalizedListed = await Promise.all(listedPaths.map(normalizePath))

  const matchIdx = normalizedListed.findIndex(p => p === targetPath)
  if (matchIdx === -1) {
    throw new Error(
      `${path} is not a registered worktree of this repository. ` +
        `Create it first with \`git worktree add\`, or use EnterWorktree with a \`name\` to create a fresh one.`,
    )
  }
  // The first entry in `git worktree list` is the main worktree — entering it
  // is a no-op that would later let ExitWorktree chdir to a stale originalCwd.
  if (matchIdx === 0) {
    throw new Error(
      `${path} is the main worktree, not a linked worktree — there is nothing to enter.`,
    )
  }

  const [originalBranch, worktreeHead, branchResult] = await Promise.all([
    getBranch(),
    readWorktreeHeadSha(targetPath),
    execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: targetPath },
    ),
  ])
  const worktreeBranch =
    branchResult.code === 0 ? branchResult.stdout.trim() : undefined

  const session: WorktreeSession = {
    originalCwd: getCwd(),
    worktreePath: targetPath,
    worktreeName: basename(targetPath),
    worktreeBranch: worktreeBranch && worktreeBranch !== 'HEAD'
      ? worktreeBranch
      : undefined,
    originalBranch,
    // NOTE: for created worktrees this is the BASE commit (diff origin for
    // countWorktreeChanges). For an attached worktree there is no base — it's
    // the worktree's current HEAD. Harmless: attached sessions always coerce to
    // keep, so this is only ever read for keep-path analytics, never to gate a
    // removal.
    originalHeadCommit: worktreeHead ?? undefined,
    sessionId,
    hookBased: false,
    attached: true,
  }
  restoreWorktreeSession(session)

  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: session,
  }))

  return session
}

export async function keepWorktree(): Promise<void> {
  const currentSession = getCurrentWorktreeSession()
  if (!currentSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentSession

    // Change back to original directory first
    process.chdir(originalCwd)

    // Clear the session but keep the worktree intact
    restoreWorktreeSession(null)

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `Linked worktree preserved at: ${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(
      `You can continue working there by running: cd ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(`Error keeping worktree: ${error}`, {
      level: 'error',
    })
  }
}

export async function cleanupWorktree(): Promise<void> {
  const currentSession = getCurrentWorktreeSession()
  if (!currentSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased } =
      currentSession

    // Change back to original directory first
    process.chdir(originalCwd)

    if (hookBased) {
      // Hook-based worktree: delegate cleanup to WorktreeRemove hook
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`Removed hook-based worktree at: ${worktreePath}`)
      } else {
        logForDebugging(
          `No WorktreeRemove hook configured, hook-based worktree left at: ${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // Git-based worktree: use git worktree remove.
      // Explicit cwd: process.chdir above does NOT update getCwd() (the state
      // CWD that execFileNoThrow defaults to). If the model cd'd to a non-repo
      // dir, the bare execFileNoThrow variant would fail silently here.
      const { code: removeCode, stderr: removeError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: originalCwd },
        )

      if (removeCode !== 0) {
        logForDebugging(`Failed to remove linked worktree: ${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`Removed linked worktree at: ${worktreePath}`)
      }
    }

    // Clear the session
    restoreWorktreeSession(null)

    // Update config
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // Delete the temporary worktree branch (git-based only)
    if (!hookBased && worktreeBranch) {
      // Wait a bit to ensure git has released all locks
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['branch', '-D', worktreeBranch],
          { cwd: originalCwd },
        )

      if (deleteBranchCode !== 0) {
        logForDebugging(
          `Could not delete worktree branch: ${deleteBranchError}`,
          { level: 'error' },
        )
      } else {
        logForDebugging(`Deleted worktree branch: ${worktreeBranch}`)
      }
    }

    logForDebugging('Linked worktree cleaned up completely')
  } catch (error) {
    logForDebugging(`Error cleaning up worktree: ${error}`, {
      level: 'error',
    })
  }
}

/**
 * Slug patterns for throwaway worktrees created by AgentTool (`agent-a<7hex>`,
 * from earlyAgentId.slice(0,8)), WorkflowTool (`wf_<runId>-<idx>` where runId
 * is randomUUID().slice(0,12) = 8 hex + `-` + 3 hex), and bridgeMain
 * (`bridge-<safeFilenameId>`). These leak when the parent process is killed
 * (Ctrl+C, ESC, crash) before their in-process cleanup runs. Exact-shape
 * patterns avoid sweeping user-named EnterWorktree slugs like `wf-myfeature`.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // Legacy wf-<idx> slugs from before workflowRunId disambiguation — kept so
  // the 30-day sweep still cleans up worktrees leaked by older builds.
  /^wf-\d+$/,
  // Real bridge slugs are `bridge-${safeFilenameId(sessionId)}`.
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // Template job worktrees: job-<templateName>-<8hex>. Prefix distinguishes
  // from user-named EnterWorktree slugs that happen to end in 8 hex.
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety:
 * - Only touches slugs matching ephemeral patterns (never user-named worktrees)
 * - Skips the current session's worktree
 * - Fail-closed: skips if git status fails or shows tracked changes
 *   (-uno: untracked files in a 30-day-old crashed agent worktree are build
 *   artifacts; skipping the untracked scan is 5-10× faster on large repos)
 * - Fail-closed: skips if any commits aren't reachable from a remote
 *
 * `git worktree remove --force` handles both the directory and git's internal
 * worktree tracking. If git doesn't recognize the path as a worktree (orphaned
 * dir), it's left in place — a later readdir finding it stale again is harmless.
 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = getCurrentWorktreeSession()?.worktreePath
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // Both checks must succeed with empty output. Non-zero exit (corrupted
    // worktree, git not recognizing it, etc.) means skip — we don't know
    // what's in there.
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(
        gitExe(),
        ['--no-optional-locks', 'status', '--porcelain', '-uno'],
        { cwd: worktreePath },
      ),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      continue
    }

    if (
      await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)
    ) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(
      `cleanupStaleAgentWorktrees: removed ${removed} stale worktree(s)`,
    )
  }
  return removed
}

/**
 * Check whether a worktree has uncommitted changes or new commits since creation.
 * Returns true if there are uncommitted changes (dirty working tree), if commits
 * were made on the worktree branch since `headCommit`, or if git commands fail
 * — callers use this to decide whether to remove a worktree, so fail-closed.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execFileNoThrowWithCwd(gitExe(), ['status', '--porcelain'], {
      cwd: worktreePath,
    })
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
    )
  if (revListCode !== 0) {
    return true
  }
  if (parseInt(revListOutput.trim(), 10) > 0) {
    return true
  }

  return false
}
