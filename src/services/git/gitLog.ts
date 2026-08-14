import type { StructuredPatchHunk } from 'diff'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
} from 'src/utils/proc/execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { parseGitDiff, parseGitNumstat, type PerFileStats } from './gitDiff.js'

// Read-only git data for the diff reviewer's Log tab and stash sources.
// Kept separate from gitDiff.ts (which these import for parsing) and from
// git.ts (which these import for gitExe/getIsGit) to avoid an import cycle.

const GIT_TIMEOUT_MS = 5000
const DEFAULT_LOG_LIMIT = 50

// ASCII separators embedded in git --format strings: US (\x1f) between fields,
// RS (\x1e) terminating each record. Chosen because they never appear in
// commit metadata, so they survive arbitrary subjects/author names.
const US = '\x1f'
const RS = '\x1e'
const LOG_FORMAT = `${US}%H${US}%h${US}%an${US}%s${US}%d${RS}`
const STASH_FORMAT = `${US}%gd${US}%s${RS}`

const HASH_RE = /^[0-9a-f]{4,40}$/i
const STASH_REF_RE = /^stash@\{\d+\}$/
const STASH_BRANCH_RE = /^(?:WIP on|On) ([^:]+):/
const HEAD_ARROW_RE = /^HEAD -> /
const RS_TAIL_RE = /\x1e\s*$/

export type GitLogRow = {
  /** Git's rail glyphs preceding the commit on this output line (e.g. "│ ", "├─╮ "). */
  graphPrefix: string
  /** False for graph-only connector lines (merges) with no commit payload. */
  isCommit: boolean
  hash: string
  shortHash: string
  author: string
  subject: string
  /** Decoration names: ["main", "origin/main", "tag: v1"]. */
  refs: string[]
}

export type CommitFile = {
  path: string
  added: number
  removed: number
  isBinary: boolean
  renamedFrom?: string
}

export type StashEntry = {
  /** Reflog selector, e.g. "stash@{0}". */
  ref: string
  subject: string
  branch: string
}

/** Run a git command against an explicit root when `cwd` is set, else ambient. */
function runGit(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; code: number }> {
  const opts = { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false }
  return cwd
    ? execFileNoThrowWithCwd(gitExe(), args, { ...opts, cwd })
    : execFileNoThrow(gitExe(), args, opts)
}

/** Parse a "(HEAD -> main, origin/main, tag: v1)" decoration into ref names. */
function parseRefs(decoration: string): string[] {
  const inner = decoration.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  if (!inner) return []
  return inner
    .split(',')
    .map(s => s.trim().replace(HEAD_ARROW_RE, ''))
    .filter(Boolean)
}

/**
 * Parse `git log --graph --format=<US-delimited>` output. Each output line is
 * either a commit (graph prefix + our delimited fields) or a graph-only
 * connector line. Pure — unit-tested.
 */
export function parseGitLog(stdout: string): GitLogRow[] {
  const rows: GitLogRow[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(RS_TAIL_RE, '')
    const sep = line.indexOf(US)
    if (sep === -1) {
      // Graph-only connector line; skip blank trailing lines.
      if (rawLine.trim() === '') continue
      rows.push({
        graphPrefix: rawLine,
        isCommit: false,
        hash: '',
        shortHash: '',
        author: '',
        subject: '',
        refs: [],
      })
      continue
    }
    const graphPrefix = line.slice(0, sep)
    const fields = line.slice(sep + US.length).split(US)
    rows.push({
      graphPrefix,
      isCommit: true,
      hash: fields[0] ?? '',
      shortHash: fields[1] ?? '',
      author: fields[2] ?? '',
      subject: fields[3] ?? '',
      refs: parseRefs(fields[4] ?? ''),
    })
  }
  return rows
}

/**
 * Fetch the most recent commits as graph rows. `skip` pages further back
 * ("load more"). Fails open to [] outside a repo / on git error.
 */
export async function fetchGitLog(options?: {
  skip?: number
  limit?: number
  cwd?: string
}): Promise<GitLogRow[]> {
  const { skip = 0, limit = DEFAULT_LOG_LIMIT, cwd } = options ?? {}
  if (!cwd && !(await getIsGit())) return []

  const args = [
    '--no-optional-locks',
    'log',
    '--graph',
    '--decorate=short',
    `--format=${LOG_FORMAT}`,
    '-n',
    String(limit),
  ]
  if (skip > 0) args.push('--skip', String(skip))

  const { stdout, code } = await runGit(args, cwd)
  if (code !== 0) return []
  return parseGitLog(stdout)
}

function toCommitFiles(perFileStats: Map<string, PerFileStats>): CommitFile[] {
  return [...perFileStats.entries()].map(([path, s]) => ({
    path,
    added: s.added,
    removed: s.removed,
    isBinary: s.isBinary,
    ...(s.renamedFrom ? { renamedFrom: s.renamedFrom } : {}),
  }))
}

/** Changed files for a single commit (numstat). Read-only. */
export async function fetchCommitFiles(
  hash: string,
  cwd?: string,
): Promise<CommitFile[]> {
  if (!HASH_RE.test(hash)) return []
  const { stdout, code } = await runGit(
    ['--no-optional-locks', 'show', '--numstat', '--format=', hash],
    cwd,
  )
  if (code !== 0) return []
  return toCommitFiles(parseGitNumstat(stdout).perFileStats)
}

/**
 * Parse `git stash list --format=<US-delimited>` output. Pure — unit-tested.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const out: StashEntry[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(RS_TAIL_RE, '')
    if (!line.startsWith(US)) continue
    const fields = line.slice(US.length).split(US)
    const ref = (fields[0] ?? '').trim()
    if (!ref) continue
    const subject = (fields[1] ?? '').trim()
    const branchMatch = subject.match(STASH_BRANCH_RE)
    out.push({ ref, subject, branch: branchMatch?.[1] ?? '' })
  }
  return out
}

/** List stashes (most recent first). Fails open to []. */
export async function fetchGitStashes(cwd?: string): Promise<StashEntry[]> {
  if (!cwd && !(await getIsGit())) return []
  const { stdout, code } = await runGit(
    ['--no-optional-locks', 'stash', 'list', `--format=${STASH_FORMAT}`],
    cwd,
  )
  if (code !== 0) return []
  return parseStashList(stdout)
}

/** Diff hunks for one stash (`git stash show -p`). Fails open to empty map. */
export async function fetchStashDiff(
  ref: string,
  cwd?: string,
): Promise<Map<string, StructuredPatchHunk[]>> {
  if (!STASH_REF_RE.test(ref)) return new Map()
  const { stdout, code } = await runGit(
    ['--no-optional-locks', 'stash', 'show', '-p', '--src-prefix=a/', '--dst-prefix=b/', ref],
    cwd,
  )
  if (code !== 0) return new Map()
  return parseGitDiff(stdout)
}

/** Changed files for one stash (numstat). Fails open to []. */
export async function fetchStashFiles(
  ref: string,
  cwd?: string,
): Promise<CommitFile[]> {
  if (!STASH_REF_RE.test(ref)) return []
  const { stdout, code } = await runGit(
    ['--no-optional-locks', 'stash', 'show', '--numstat', ref],
    cwd,
  )
  if (code !== 0) return []
  return toCommitFiles(parseGitNumstat(stdout).perFileStats)
}
