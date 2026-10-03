/**
 * Creating (or fast-resuming) a worktree: the `git worktree add` core, the
 * session-scoped wrapper that publishes it as the current worktree session,
 * and the agent-scoped pair that deliberately does not.
 */

import { mkdir, utimes } from 'fs/promises'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from 'src/platform/lifecycleHooks/hooks.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findCanonicalGitRoot, getBranch, getDefaultBranch } from 'src/vcs/git/git.js'
import { readWorktreeHeadSha } from 'src/vcs/git/gitFilesystem.js'
import {
  baseSourceFor,
  defaultBranchPlan,
  LOCAL_HEAD_PLAN,
  pullRequestPlan,
  type BasePlan,
  type BaseSource,
} from 'src/vcs/git/worktree/baseChoice.js'
import { complaintOf, git, gitWithoutPrompts } from 'src/vcs/git/worktree/gitCommand.js'
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

const PULL_REQUEST_REFERENCE = /^#(\d+)$/
// scheme://host/owner/repo/pull/<n>, then an optional `/`, query and fragment.
const PULL_REQUEST_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i

const NO_GIT_FOR_SESSION =
  'Cannot create a worktree: not in a git repository. ' +
  'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktrees with other VCS systems.'
// AgentTool matches the first sentence to fall back to the current directory.
const NO_GIT_FOR_AGENT =
  'Cannot create agent worktree: not in a git repository. ' +
  'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktrees with other VCS systems.'

function sparsePathsSetting(): string[] {
  return getInitialSettings().worktree?.sparsePaths ?? []
}

async function planFor(repoRoot: string, source: BaseSource): Promise<BasePlan> {
  switch (source.kind) {
    case 'pull-request':
      return pullRequestPlan(source.prNumber)
    case 'local-head':
      return LOCAL_HEAD_PLAN
    case 'default-branch': {
      const branch = await getDefaultBranch()
      const tracking = await git(repoRoot, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
      return defaultBranchPlan(branch, tracking.ok)
    }
  }
}

/** Carries out a plan; answers the commit and the name it was reached by. */
async function resolveBase(
  repoRoot: string,
  source: BaseSource,
): Promise<{ commit: string; label: string }> {
  const plan = await planFor(repoRoot, source)
  let ref = plan.ref
  if (plan.fetch !== null) {
    const fetched = await gitWithoutPrompts(repoRoot, 'fetch', 'origin', plan.fetch)
    if (!fetched.ok) {
      if (plan.fallback === null) {
        const why =
          complaintOf(fetched) ||
          'git said nothing; the pull request may not exist, or there may be no "origin" remote'
        throw new Error(
          source.kind === 'pull-request'
            ? `Failed to fetch PR #${source.prNumber}: ${why}`
            : `Failed to fetch ${plan.fetch}: ${why}`,
        )
      }
      logForDebugging(`worktree: fetching ${plan.fetch} failed, basing on ${plan.fallback}`)
      ref = plan.fallback
    }
  }
  const resolved = await git(repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  const commit = resolved.stdout.trim()
  if (!resolved.ok || commit === '') {
    throw new Error(`Could not resolve the base branch "${ref}" to a commit; the repository may have no commits yet`)
  }
  return { commit, label: ref }
}

/** Removes a half-made worktree; its branch may stay. */
async function discardWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const removed = await git(repoRoot, 'worktree', 'remove', '--force', worktreePath)
  if (!removed.ok) logForDebugging(`worktree: could not discard ${worktreePath}: ${complaintOf(removed)}`)
}

async function narrowToSparsePaths(repoRoot: string, worktreePath: string, paths: string[]): Promise<void> {
  const configured = await git(worktreePath, 'sparse-checkout', 'set', '--cone', ...paths)
  if (!configured.ok) {
    await discardWorktree(repoRoot, worktreePath)
    throw new Error(`Failed to configure sparse-checkout: ${complaintOf(configured)}`)
  }
  const checkedOut = await git(worktreePath, 'checkout', 'HEAD')
  if (!checkedOut.ok) {
    await discardWorktree(repoRoot, worktreePath)
    throw new Error(`Failed to checkout sparse worktree: ${complaintOf(checkedOut)}`)
  }
}

async function addWorktree(repoRoot: string, worktreePath: string, branch: string, commit: string): Promise<void> {
  const sparsePaths = sparsePathsSetting()
  const sparse = sparsePaths.length > 0
  // -B creates the branch, or resets a leftover one that nothing has checked out.
  const added = await git(
    repoRoot,
    'worktree',
    'add',
    ...(sparse ? ['--no-checkout'] : []),
    '-B',
    branch,
    worktreePath,
    commit,
  )
  if (!added.ok) throw new Error(`Failed to create worktree: ${complaintOf(added)}`)
  if (sparse) await narrowToSparsePaths(repoRoot, worktreePath, sparsePaths)
}

export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)
  const resumed = async (): Promise<WorktreeCreateResult | null> => {
    const head = await readWorktreeHeadSha(worktreePath)
    return head === null ? null : { worktreePath, worktreeBranch, headCommit: head, existed: true }
  }

  const early = await resumed()
  if (early !== null) return early
  return withGitWorktreeMutationLock(repoRoot, async () => {
    // Someone holding the lock before us may have just made it.
    const raced = await resumed()
    if (raced !== null) return raced
    const base = await resolveBase(repoRoot, baseSourceFor(options?.prNumber, getInitialSettings().worktree?.baseRef))
    await mkdir(worktreesDir(repoRoot), { recursive: true })
    await addWorktree(repoRoot, worktreePath, worktreeBranch, base.commit)
    return { worktreePath, worktreeBranch, headCommit: base.commit, baseBranch: base.label, existed: false }
  })
}

export function parsePRReference(input: string): number | null {
  const digits = PULL_REQUEST_REFERENCE.exec(input)?.[1] ?? PULL_REQUEST_URL.exec(input)?.[1]
  return digits === undefined ? null : Number.parseInt(digits, 10)
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  validateWorktreeSlug(slug)
  const originalCwd = getCwd()

  let session: WorktreeSession
  if (hasWorktreeCreateHook()) {
    const { worktreePath } = await executeWorktreeCreateHook(slug)
    session = { originalCwd, worktreePath, worktreeName: slug, sessionId, tmuxSessionName, hookBased: true }
  } else {
    const repoRoot = findCanonicalGitRoot(originalCwd)
    if (repoRoot === null) throw new Error(NO_GIT_FOR_SESSION)
    const startedAt = Date.now()
    const originalBranch = await getBranch()
    const made = await getOrCreateWorktree(repoRoot, slug, options)
    if (!made.existed) await performPostCreationSetup(repoRoot, made.worktreePath)
    session = {
      originalCwd,
      worktreePath: made.worktreePath,
      worktreeName: slug,
      worktreeBranch: made.worktreeBranch,
      originalBranch,
      originalHeadCommit: made.headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs: made.existed ? undefined : Date.now() - startedAt,
      usedSparsePaths: sparsePathsSetting().length > 0,
    }
  }

  restoreWorktreeSession(session)
  return session
}

async function freshenModificationTime(path: string): Promise<void> {
  const now = new Date()
  try {
    await utimes(path, now, now)
  } catch (error) {
    logForDebugging(`worktree: could not touch ${path}: ${errorMessage(error)}`)
  }
}

export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)
  if (hasWorktreeCreateHook()) {
    const { worktreePath } = await executeWorktreeCreateHook(slug)
    return { worktreePath, hookBased: true }
  }

  const gitRoot = findCanonicalGitRoot(getCwd())
  if (gitRoot === null) throw new Error(NO_GIT_FOR_AGENT)
  const made = await getOrCreateWorktree(gitRoot, slug)
  // A resumed worktree is in use again: keep the stale sweep away from it.
  if (made.existed) await freshenModificationTime(made.worktreePath)
  else await performPostCreationSetup(gitRoot, made.worktreePath)
  return { worktreePath: made.worktreePath, worktreeBranch: made.worktreeBranch, headCommit: made.headCommit, gitRoot }
}

export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) return executeWorktreeRemoveHook(worktreePath)
  if (!gitRoot) return false

  return withGitWorktreeMutationLock(gitRoot, async () => {
    const removed = await git(gitRoot, 'worktree', 'remove', '--force', worktreePath)
    if (!removed.ok) {
      logForDebugging(`worktree: could not remove ${worktreePath}: ${complaintOf(removed)}`)
      return false
    }
    if (worktreeBranch) {
      const deleted = await git(gitRoot, 'branch', '-D', worktreeBranch)
      if (!deleted.ok) logForDebugging(`worktree: kept branch ${worktreeBranch}: ${complaintOf(deleted)}`)
    }
    return true
  })
}
