/**
 * Creating (or fast-resuming) a worktree: the `git worktree add` core, the
 * session-scoped wrapper that records it in `currentWorktreeSession`, and the
 * agent-scoped pair that deliberately does not.
 */

import { mkdir, utimes } from 'fs/promises'
import { saveCurrentProjectConfig } from 'src/platform/config/config.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from 'src/platform/lifecycleHooks/hooks.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from 'src/vcs/git/git.js'
import {
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from 'src/vcs/git/gitFilesystem.js'
import { GIT_NO_PROMPT_ENV } from 'src/vcs/git/noPromptEnv.js'
import { withGitWorktreeMutationLock } from 'src/vcs/git/worktree/mutationLock.js'
import { performPostCreationSetup } from 'src/vcs/git/worktree/postCreationSetup.js'
import {
  restoreWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree/session.js'
import {
  validateWorktreeSlug,
  worktreeBranchName,
  worktreePathFor,
  worktreesDir,
} from 'src/vcs/git/worktree/slugNaming.js'

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

// Env vars to prevent git/SSH from prompting for credentials (which hangs the
// CLI); defined in ./git/noPromptEnv.js so the Git tool can reuse the same
// constant without importing this module. stdin: 'ignore' at each call site
// closes stdin so interactive prompts can't block.

/**
 * Creates a new git worktree for the given slug, or resumes it if it already exists.
 * Named worktrees reuse the same path across invocations, so the existence check
 * prevents unconditionally running `git fetch` (which can hang waiting for credentials)
 * on every resume.
 */
export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // Fast resume path: if the worktree already exists skip fetch and creation.
  // Read the .git pointer file directly (no subprocess, no upward walk) — a
  // subprocess `rev-parse HEAD` burns ~15ms on spawn overhead even for a 2ms
  // task, and the await yield lets background spawnSyncs pile on (seen at 55ms).
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  return withGitWorktreeMutationLock(repoRoot, async () => {
    const lockedExistingHead = await readWorktreeHeadSha(worktreePath)
    if (lockedExistingHead) {
      return {
        worktreePath,
        worktreeBranch,
        headCommit: lockedExistingHead,
        existed: true,
      }
    }

    // New worktree: fetch base branch then add
    await mkdir(worktreesDir(repoRoot), { recursive: true })

    const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }

    let baseBranch: string
    let baseSha: string | null = null
    if (options?.prNumber) {
      const { code: prFetchCode, stderr: prFetchStderr } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['fetch', 'origin', `pull/${options.prNumber}/head`],
          { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
        )
      if (prFetchCode !== 0) {
        throw new Error(
          `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
        )
      }
      baseBranch = 'FETCH_HEAD'
    } else if ((getInitialSettings().worktree?.baseRef ?? 'fresh') === 'head') {
      // baseRef: 'head' — branch from the current local HEAD instead of
      // origin/<default>. The user opted into basing the worktree on their
      // local state (uncommitted commits, a feature branch, etc.). baseSha is
      // resolved by the `if (!baseSha)` block below via `git rev-parse HEAD`.
      baseBranch = 'HEAD'
    } else {
      // baseRef: 'fresh' (default) — base on origin/<default-branch>.
      // If origin/<branch> already exists locally, skip fetch. In large repos
      // (210k files, 16M objects) fetch burns ~6-8s on a local commit-graph
      // scan before even hitting the network. A slightly stale base is fine —
      // the user can pull in the worktree if they want latest.
      // resolveRef reads the loose/packed ref directly; when it succeeds we
      // already have the SHA, so the later rev-parse is skipped entirely.
      const [defaultBranch, gitDir] = await Promise.all([
        getDefaultBranch(),
        resolveGitDir(repoRoot),
      ])
      const originRef = `origin/${defaultBranch}`
      const originSha = gitDir
        ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
        : null
      if (originSha) {
        baseBranch = originRef
        baseSha = originSha
      } else {
        const { code: fetchCode } = await execFileNoThrowWithCwd(
          gitExe(),
          ['fetch', 'origin', defaultBranch],
          { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
        )
        baseBranch = fetchCode === 0 ? originRef : 'HEAD'
      }
    }

    // For the fetch/PR-fetch paths we still need the SHA — the fs-only resolveRef
    // above only covers the "origin/<branch> already exists locally" case.
    if (!baseSha) {
      const { stdout, code: shaCode } = await execFileNoThrowWithCwd(
        gitExe(),
        ['rev-parse', baseBranch],
        { cwd: repoRoot },
      )
      if (shaCode !== 0) {
        throw new Error(
          `Failed to resolve base branch "${baseBranch}": git rev-parse failed`,
        )
      }
      baseSha = stdout.trim()
    }

    const sparsePaths = getInitialSettings().worktree?.sparsePaths
    const addArgs = ['worktree', 'add']
    if (sparsePaths?.length) {
      addArgs.push('--no-checkout')
    }
    // -B (not -b): reset any orphan branch left behind by a removed worktree dir.
    // Saves a `git branch -D` subprocess (~15ms spawn overhead) on every create.
    addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)

    const { code: createCode, stderr: createStderr } =
      await execFileNoThrowWithCwd(gitExe(), addArgs, { cwd: repoRoot })
    if (createCode !== 0) {
      throw new Error(`Failed to create worktree: ${createStderr}`)
    }

    if (sparsePaths?.length) {
      // If sparse-checkout or checkout fail after --no-checkout, the worktree
      // is registered and HEAD is set but the working tree is empty. Next run's
      // fast-resume (rev-parse HEAD) would succeed and present a broken worktree
      // as "resumed". Tear it down before propagating the error.
      const tearDown = async (msg: string): Promise<never> => {
        await execFileNoThrowWithCwd(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: repoRoot },
        )
        throw new Error(msg)
      }
      const { code: sparseCode, stderr: sparseErr } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
          { cwd: worktreePath },
        )
      if (sparseCode !== 0) {
        await tearDown(`Failed to configure sparse-checkout: ${sparseErr}`)
      }
      const { code: coCode, stderr: coErr } = await execFileNoThrowWithCwd(
        gitExe(),
        ['checkout', 'HEAD'],
        { cwd: worktreePath },
      )
      if (coCode !== 0) {
        await tearDown(`Failed to checkout sparse worktree: ${coErr}`)
      }
    }

    return {
      worktreePath,
      worktreeBranch,
      headCommit: baseSha,
      baseBranch,
      existed: false,
    }
  })
}

/**
 * Parses a PR reference from a string.
 * Accepts GitHub-style PR URLs (e.g., https://github.com/owner/repo/pull/123,
 * or GHE equivalents like https://ghe.example.com/owner/repo/pull/123)
 * or `#N` format (e.g., #123).
 * Returns the PR number or null if the string is not a recognized PR reference.
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123 (with optional trailing slash, query, hash)
  // The /pull/N path shape is specific to GitHub — GitLab uses /-/merge_requests/N,
  // Bitbucket uses /pull-requests/N — so matching any host here is safe.
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  // Must run before the hook branch below — hooks receive the raw slug as an
  // argument, and the git branch builds a path from it via path.join.
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // Built as a local and then published through restoreWorktreeSession: the
  // `currentWorktreeSession` binding is private to session.ts, which is what
  // keeps there being exactly one of it.
  let session: WorktreeSession

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based worktree at: ${hookResult.worktreePath}`,
    )

    session = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // Fall back to git worktree
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(
        'Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
          'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
      )
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } =
      await getOrCreateWorktree(gitRoot, slug, options)

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`Resuming existing worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `Created worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
      )
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    session = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths:
        (getInitialSettings().worktree?.sparsePaths?.length ?? 0) > 0,
    }
  }

  restoreWorktreeSession(session)

  // Save to project config for persistence
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: session,
  }))

  return session
}

/**
 * Create a lightweight worktree for a subagent.
 * Reuses getOrCreateWorktree/performPostCreationSetup but does NOT touch
 * global session state (currentWorktreeSession, process.chdir, project config).
 * Falls back to hook-based creation if not in a git repository.
 */
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // Try hook-based worktree creation first (allows user-configured VCS)
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `Created hook-based agent worktree at: ${hookResult.worktreePath}`,
    )

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // Fall back to git worktree
  // findCanonicalGitRoot (not findGitRoot) so agent worktrees always land in
  // the main repo's .claudin/worktrees/ even when spawned from inside a session
  // worktree — otherwise they nest at <worktree>/.claudin/worktrees/ and the
  // periodic cleanup (which scans the canonical root) never finds them.
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug)

  if (!existed) {
    logForDebugging(
      `Created agent worktree at: ${worktreePath} on branch: ${worktreeBranch}`,
    )
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // Bump mtime so the periodic stale-worktree cleanup doesn't consider this
    // worktree stale — the fast-resume path is read-only and leaves the original
    // creation-time mtime intact, which can be past the 30-day cutoff.
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`Resuming existing agent worktree at: ${worktreePath}`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/**
 * Remove a worktree created by createAgentWorktree.
 * For git-based worktrees, removes the worktree directory and deletes the temporary branch.
 * For hook-based worktrees, delegates to the WorktreeRemove hook.
 * Must be called with the main repo's git root (for git worktrees), not the worktree path,
 * since the worktree directory is deleted during this operation.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`Removed hook-based agent worktree at: ${worktreePath}`)
    } else {
      logForDebugging(
        `No WorktreeRemove hook configured, hook-based agent worktree left at: ${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('Cannot remove agent worktree: no git root provided', {
      level: 'error',
    })
    return false
  }

  return withGitWorktreeMutationLock(gitRoot, async () => {
    // Run from the main repo root, not the worktree (which we're about to delete)
    const { code: removeCode, stderr: removeError } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: gitRoot },
      )

    if (removeCode !== 0) {
      logForDebugging(`Failed to remove agent worktree: ${removeError}`, {
        level: 'error',
      })
      return false
    }
    logForDebugging(`Removed agent worktree at: ${worktreePath}`)

    if (!worktreeBranch) {
      return true
    }

    // Delete the temporary worktree branch from the main repo
    const { code: deleteBranchCode, stderr: deleteBranchError } =
      await execFileNoThrowWithCwd(gitExe(), ['branch', '-D', worktreeBranch], {
        cwd: gitRoot,
      })

    if (deleteBranchCode !== 0) {
      logForDebugging(
        `Could not delete agent worktree branch: ${deleteBranchError}`,
        { level: 'error' },
      )
    }
    return true
  })
}
