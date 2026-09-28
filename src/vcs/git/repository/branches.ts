import { type AheadBehind, parseAheadBehind } from 'src/vcs/git/repository/aheadBehind.js'
import {
  QUICK_READ_TIMEOUT_MS,
  runGit,
  type WorkingDirectory,
} from 'src/vcs/git/repository/runGit.js'

// Tried in this order when the branch has no upstream. Only refs already
// fetched are consulted: origin is never contacted, which could be slow,
// reach a credential helper, and never changed the answer anyway.
const FALLBACK_BASE_BRANCHES = ['main', 'staging', 'master'] as const

/** The branch checked out in `dir`: its name, `HEAD` when detached, '' on an unborn branch or any failure. */
export async function readBranchIn(dir: string): Promise<string> {
  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: { dir },
    timeoutMs: QUICK_READ_TIMEOUT_MS,
  })
  return head.ok ? head.stdout.trim() : ''
}

/** Whether the session branch has an upstream that resolves. Whether HEAD was pushed is not asked. */
export async function getIsHeadOnRemote(): Promise<boolean> {
  return (await readUpstream('session')) !== null
}

/** Counted in `cwd`, or in the session cwd; zeros without an upstream, outside a repository, or on failure. */
export async function getAheadBehind(cwd?: string): Promise<AheadBehind> {
  const counts = await runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
    cwd: cwd ? { dir: cwd } : 'session',
    timeoutMs: QUICK_READ_TIMEOUT_MS,
  })
  return counts.ok ? parseAheadBehind(counts.stdout) : { ahead: 0, behind: 0 }
}

/**
 * The base a review of the process directory's branch compares against: its
 * upstream as `<remote>/<branch>`, else the first of origin/main,
 * origin/staging and origin/master that was fetched, else null.
 */
export async function findRemoteBase(): Promise<string | null> {
  return (await readUpstream('process')) ?? (await firstFetchedBase())
}

async function readUpstream(cwd: WorkingDirectory): Promise<string | null> {
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd })
  const name = upstream.ok ? upstream.stdout.trim() : ''
  return name === '' ? null : name
}

async function firstFetchedBase(): Promise<string | null> {
  const refs = FALLBACK_BASE_BRANCHES.map(branch => `refs/remotes/origin/${branch}`)
  const listed = await runGit(['for-each-ref', '--format=%(refname)', ...refs], {
    cwd: 'process',
  })
  if (!listed.ok) return null
  const fetched = new Set(listed.stdout.split('\n'))
  const base = FALLBACK_BASE_BRANCHES.find(branch => fetched.has(`refs/remotes/origin/${branch}`))
  return base === undefined ? null : `origin/${base}`
}
