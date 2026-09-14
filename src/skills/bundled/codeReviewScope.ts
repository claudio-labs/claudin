import { execFileNoThrow } from 'src/shared/proc/execFileNoThrow.js'
import { logError } from 'src/shared/log.js'
import { findRemoteBase, getIsGit, gitExe } from 'src/vcs/git/git.js'

/**
 * Resolve the review scope for `/code-review` in code instead of asking the
 * model to pick a `git diff` invocation.
 *
 * The skill used to open with a fallback chain the *model* walked
 * (`@{upstream}...HEAD`, else `main...HEAD`, else `HEAD~1`, plus `git diff HEAD`
 * "if there are uncommitted changes"), so two runs over the same tree could
 * review different diffs, and each finder angle re-picked independently. Here
 * the range is resolved once, named once, and the file list ships inside the
 * prompt.
 *
 * Every failure path returns `null` — the caller falls back to the old
 * prompt-driven wording, so a missing repo or an unusual branch layout never
 * blocks a review.
 */

export type ScopeFile = {
  path: string
  additions: number
  deletions: number
  binary: boolean
  /**
   * Untracked: the file exists only in the working tree, so it is absent from
   * BOTH `git diff` passes. The prompt has to send the reviewer to Read it, or
   * a review of pre-commit work silently skips every new file in the change.
   */
  untracked: boolean
}

export type ReviewScope = {
  /** Committed range, e.g. `origin/main...HEAD`. Empty when only the working tree differs. */
  range: string
  /** True when `git diff HEAD` contributed tracked working-tree changes. */
  includesWorkingTree: boolean
  /** Changed files: untracked first by path, then tracked by churn. */
  files: ScopeFile[]
  totalAdditions: number
  totalDeletions: number
}

/** Files listed individually in the prompt; the rest are summarized as a count. */
const MAX_LISTED_FILES = 60

/** Rows of `git diff --numstat`: `<added>\t<deleted>\t<path>`, `-` for binary. */
export function parseNumstat(stdout: string): ScopeFile[] {
  const files: ScopeFile[] = []
  for (const line of stdout.split('\n')) {
    const row = line.trimEnd()
    if (!row) continue
    const parts = row.split('\t')
    if (parts.length < 3) continue
    const [added, deleted, ...rest] = parts
    const path = rest.join('\t')
    if (!path || added === undefined || deleted === undefined) continue
    const binary = added === '-' || deleted === '-'
    files.push({
      path,
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
      untracked: false,
    })
  }
  return files
}

/** Rows of `git ls-files --others --exclude-standard`: one path per line. */
export function parseUntracked(stdout: string): ScopeFile[] {
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(path => ({
      path,
      additions: 0,
      deletions: 0,
      binary: false,
      untracked: true,
    }))
}

/**
 * Union the committed and working-tree passes: a file touched by both is one
 * entry whose churn is the larger of the two, since the working-tree diff of a
 * committed file already restates it.
 *
 * Untracked files sort first: a whole new file is the largest change in any
 * diff and the likeliest place for a defect, yet it carries no churn numbers to
 * rank it by. The rest go by churn, so truncation keeps the files worth
 * reviewing, with the path as a deterministic tie-break throughout.
 */
export function mergeScopeFiles(passes: ScopeFile[][]): ScopeFile[] {
  const byPath = new Map<string, ScopeFile>()
  for (const pass of passes) {
    for (const file of pass) {
      const seen = byPath.get(file.path)
      if (!seen) {
        byPath.set(file.path, { ...file })
        continue
      }
      seen.additions = Math.max(seen.additions, file.additions)
      seen.deletions = Math.max(seen.deletions, file.deletions)
      seen.binary = seen.binary || file.binary
      seen.untracked = seen.untracked && file.untracked
    }
  }
  return [...byPath.values()].sort((a, b) => {
    if (a.untracked !== b.untracked) return a.untracked ? -1 : 1
    if (a.untracked) return a.path.localeCompare(b.path)
    const churn = b.additions + b.deletions - (a.additions + a.deletions)
    return churn !== 0 ? churn : a.path.localeCompare(b.path)
  })
}

/** The `## Scope` block: one named range, one file list, for every angle. */
export function formatReviewScope(scope: ReviewScope): string {
  const commands = [
    scope.range ? `git diff ${scope.range}` : '',
    scope.includesWorkingTree ? 'git diff HEAD' : '',
  ].filter(Boolean)

  const listed = scope.files.slice(0, MAX_LISTED_FILES)
  const remaining = scope.files.length - listed.length
  const lines = listed.map(f => {
    if (f.untracked) return `- ${f.path} (new file, untracked)`
    if (f.binary) return `- ${f.path} (binary)`
    return `- ${f.path} (+${f.additions} −${f.deletions})`
  })
  if (remaining > 0) {
    lines.push(`- …and ${remaining} more file${remaining === 1 ? '' : 's'}`)
  }

  const fileCount = `${scope.files.length} file${scope.files.length === 1 ? '' : 's'}`
  const untrackedNote = scope.files.some(f => f.untracked)
    ? `
The files marked \`(new file, untracked)\` are NOT in the output of those
commands — git has never seen them. Read each one in full; it is part of the
change under review.
`
    : ''

  // Nothing is committed or tracked yet — every file below is new, so there is
  // no diff to fetch and the "use this range" instruction would name nothing.
  const lead =
    commands.length > 0
      ? `The diff under review is already resolved. Fetch it with exactly these commands —
every angle below must use the same range, do not substitute another one:

${commands.map(c => `    ${c}`).join('\n')}
`
      : `The change under review is entirely new files — there is no diff to fetch.
Read each file below in full.
`

  return `## Scope

${lead}
${fileCount}, +${scope.totalAdditions} −${scope.totalDeletions}:

${lines.join('\n')}
${untrackedNote}`
}

/** Run `git diff --numstat <args>`, returning `null` when git refuses. */
async function numstat(args: string[]): Promise<ScopeFile[] | null> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['diff', '--numstat', ...args],
    { preserveOutputOnError: false },
  )
  return code === 0 ? parseNumstat(stdout) : null
}

async function revExists(rev: string): Promise<boolean> {
  const { code } = await execFileNoThrow(gitExe(), ['rev-parse', '--verify', rev], {
    preserveOutputOnError: false,
  })
  return code === 0
}

/** Files git has never seen — invisible to every `git diff` pass. */
async function untrackedFiles(): Promise<ScopeFile[]> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['ls-files', '--others', '--exclude-standard'],
    { preserveOutputOnError: false },
  )
  return code === 0 ? parseUntracked(stdout) : []
}

/**
 * Resolve the committed range plus tracked working-tree changes. Returns `null`
 * when there is no repo, no usable base, or nothing changed — all cases the
 * prompt's fallback wording handles better than an empty file list would.
 */
export async function resolveReviewScope(): Promise<ReviewScope | null> {
  try {
    if (!(await getIsGit())) return null

    const base = await findRemoteBase()
    let range = ''
    if (base && (await revExists(base))) {
      range = `${base}...HEAD`
    } else if (await revExists('HEAD~1')) {
      range = 'HEAD~1'
    }

    const committed = range ? ((await numstat([range])) ?? []) : []
    const working = (await numstat(['HEAD'])) ?? []
    const untracked = await untrackedFiles()
    const files = mergeScopeFiles([committed, working, untracked])
    if (files.length === 0) return null

    return {
      range: committed.length > 0 ? range : '',
      includesWorkingTree: working.length > 0,
      files,
      totalAdditions: files.reduce((n, f) => n + f.additions, 0),
      totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  } catch (e) {
    logError(e)
    return null
  }
}
