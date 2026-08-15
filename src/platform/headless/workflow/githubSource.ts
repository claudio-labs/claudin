// GitHub + git glue for the self-hosted background agent (R3).
//
// All GitHub operations go through the `gh` CLI (outbound only — no inbound
// webhook server), mirroring the existing `gh` usage in
// src/commands/install-github-app/install-github-app.tsx. Git operations use
// the same execFileNoThrow wrapper. Every helper fails soft (logs + returns a
// falsy/empty value) so the watcher loop never crashes on a transient forge
// error.

import { execFileNoThrow } from 'src/shared/proc/execFileNoThrow.js'
import { logError } from 'src/shared/log.js'

/** An open issue that carries the trigger label. */
export type TriggerIssue = {
  number: number
  title: string
  body: string
  updatedAt: string
}

// `gh pr create` prints the created PR URL as the last non-empty stdout line.
const PR_URL_RE = /https:\/\/[^\s]+\/pull\/\d+/

/** Parse `gh issue list --json …` stdout into trigger issues (pure). */
export function parseTriggerIssues(stdout: string): TriggerIssue[] {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (i): i is TriggerIssue =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as TriggerIssue).number === 'number',
    )
  } catch (e) {
    logError(
      `failed to parse gh issue list output: ${e instanceof Error ? e.message : String(e)}`,
    )
    return []
  }
}

/** Strip `origin/` from a `git rev-parse --abbrev-ref origin/HEAD` ref (pure). */
export function parseDefaultBranch(ref: string): string {
  const trimmed = ref.trim() // e.g. "origin/main"
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed || 'main' : trimmed.slice(slash + 1) || 'main'
}

/**
 * Extract the PR URL from `gh pr create` stdout, or null (pure). Only ever
 * returns a real PR URL — never arbitrary stdout — so a non-URL line (a gh
 * warning/interstitial) can't be reported back as a bogus "PR: <garbage>".
 */
export function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(PR_URL_RE)
  if (match) return match[0]
  const trimmed = stdout.trim()
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null
}

/**
 * List open issues carrying `label`, newest activity first. Returns [] on any
 * gh failure (not authenticated, no such label, offline).
 */
export async function listTriggerIssues(label: string): Promise<TriggerIssue[]> {
  const { stdout, code, error } = await execFileNoThrow('gh', [
    'issue',
    'list',
    '--label',
    label,
    '--state',
    'open',
    '--json',
    'number,title,body,updatedAt',
  ])
  if (code !== 0) {
    if (error) logError(`gh issue list failed: ${error}`)
    return []
  }
  return parseTriggerIssues(stdout)
}

/** Resolve the remote default branch (origin/HEAD), falling back to `main`. */
export async function getDefaultBranch(): Promise<string> {
  const { stdout, code } = await execFileNoThrow('git', [
    'rev-parse',
    '--abbrev-ref',
    'origin/HEAD',
  ])
  if (code !== 0) return 'main'
  return parseDefaultBranch(stdout)
}

/** True when the working tree has staged or unstaged changes. */
export async function hasUncommittedChanges(): Promise<boolean> {
  const { stdout, code } = await execFileNoThrow('git', ['status', '--porcelain'])
  if (code !== 0) return false
  return stdout.trim().length > 0
}

/** Stage everything and commit. Returns true when a commit was created. */
export async function commitAllChanges(message: string): Promise<boolean> {
  const add = await execFileNoThrow('git', ['add', '-A'])
  if (add.code !== 0) {
    logError(`git add failed: ${add.error ?? add.stderr}`)
    return false
  }
  const commit = await execFileNoThrow('git', ['commit', '-m', message])
  if (commit.code !== 0) {
    logError(`git commit failed: ${commit.error ?? commit.stderr}`)
    return false
  }
  return true
}

/** Push `branch` to origin, setting upstream. Returns true on success. */
export async function pushBranch(branch: string): Promise<boolean> {
  const { code, stderr, error } = await execFileNoThrow('git', [
    'push',
    '-u',
    'origin',
    branch,
  ])
  if (code !== 0) {
    logError(`git push failed: ${error ?? stderr}`)
    return false
  }
  return true
}

/**
 * Open a PR via `gh pr create`. Returns the PR URL, or null on failure.
 * The body is read from `bodyFile` so multi-line markdown survives verbatim.
 */
export async function createPullRequest(opts: {
  base: string
  head: string
  title: string
  bodyFile: string
}): Promise<string | null> {
  const { stdout, code, stderr, error } = await execFileNoThrow('gh', [
    'pr',
    'create',
    '--base',
    opts.base,
    '--head',
    opts.head,
    '--title',
    opts.title,
    '--body-file',
    opts.bodyFile,
  ])
  if (code !== 0) {
    logError(`gh pr create failed: ${error ?? stderr}`)
    return null
  }
  return extractPrUrl(stdout)
}

/** Post a comment on an issue. Returns true on success. */
export async function commentOnIssue(
  issueNumber: number,
  body: string,
): Promise<boolean> {
  const { code, stderr, error } = await execFileNoThrow('gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--body',
    body,
  ])
  if (code !== 0) {
    logError(`gh issue comment failed: ${error ?? stderr}`)
    return false
  }
  return true
}
