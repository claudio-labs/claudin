import type { StructuredPatchHunk } from 'diff'
import { access, readFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { getCwd } from 'src/utils/fs/cwd.js'
import { getCachedRepository } from './detectRepository.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from 'src/utils/proc/execFileNoThrow.js'
import { isFileWithinReadSizeLimit } from 'src/utils/fs/file.js'
import {
  findGitRoot,
  getDefaultBranch,
  getGitDir,
  getHead,
  getIsGit,
  gitExe,
} from './git.js'

export type GitDiffStats = {
  filesCount: number
  linesAdded: number
  linesRemoved: number
}

export type PerFileStats = {
  added: number
  removed: number
  isBinary: boolean
  isUntracked?: boolean
  /** Original path when git detected a rename (numstat `old => new`). */
  renamedFrom?: string
}

export type GitDiffResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
  hunks: Map<string, StructuredPatchHunk[]>
}

const GIT_TIMEOUT_MS = 5000
const MAX_FILES = 50
const MAX_DIFF_SIZE_BYTES = 1_000_000 // 1 MB - skip files larger than this
const MAX_LINES_PER_FILE = 400 // GitHub's auto-load limit
const MAX_FILES_FOR_DETAILS = 500 // Skip per-file details if more files than this

const RENAME_BRACE_RE = /\{(.*?) => (.*?)\}/
const RENAME_ARROW = ' => '

/**
 * Run a git command against an explicit repo root when `cwd` is provided
 * (multi-repo workspace diffing), or the ambient cwd otherwise. Always
 * resolves; callers fail-open on a non-zero `code`.
 */
function runGit(
  args: string[],
  cwd?: string,
  timeout: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; code: number }> {
  const opts = { timeout, preserveOutputOnError: false }
  return cwd
    ? execFileNoThrowWithCwd(gitExe(), args, { ...opts, cwd })
    : execFileNoThrow(gitExe(), args, opts)
}

/**
 * Resolve a numstat path that may encode a rename. Git emits two forms:
 *   "old/path => new/path"            (no common prefix/suffix)
 *   "src/{old => new}/file.ts"        (brace form with common segments)
 * Returns the new path plus the original (renamedFrom) when a rename is
 * detected, else just the path unchanged.
 */
function parseRenamePath(raw: string): { path: string; renamedFrom?: string } {
  if (!raw.includes(RENAME_ARROW)) return { path: raw }
  const brace = raw.match(RENAME_BRACE_RE)
  if (brace) {
    const oldPart = brace[1] ?? ''
    const newPart = brace[2] ?? ''
    const collapse = (part: string) =>
      raw.replace(RENAME_BRACE_RE, part).replace(/\/\//g, '/')
    return { path: collapse(newPart), renamedFrom: collapse(oldPart) }
  }
  const [oldPath, newPath] = raw.split(RENAME_ARROW)
  return { path: (newPath ?? raw).trim(), renamedFrom: (oldPath ?? '').trim() }
}

/**
 * Fetch git diff stats and hunks comparing working tree to HEAD.
 * Returns null if not in a git repo or if git commands fail.
 *
 * Returns null during merge/rebase/cherry-pick/revert operations since the
 * working tree contains incoming changes that weren't intentionally
 * made by the user.
 */
export async function fetchGitDiff(
  cwd?: string,
): Promise<GitDiffResult | null> {
  // For the ambient repo, gate on the memoized getIsGit. When an explicit
  // repo root is passed (workspace diffing), trust the caller's resolved
  // root and let the git command fail-open instead.
  if (!cwd && !(await getIsGit())) return null

  // Skip diff calculation during transient git states since the
  // working tree contains incoming changes, not user-intentional edits
  if (await isInTransientGitState(cwd)) {
    return null
  }

  // Quick probe: use --shortstat to get totals without loading all content.
  // This is O(1) memory and lets us detect massive diffs (e.g., jj workspaces)
  // before committing to expensive operations.
  const { stdout: shortstatOut, code: shortstatCode } = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--shortstat'],
    cwd,
  )

  if (shortstatCode === 0) {
    const quickStats = parseShortstat(shortstatOut)
    if (quickStats && quickStats.filesCount > MAX_FILES_FOR_DETAILS) {
      // Too many files - return accurate totals but skip per-file details
      // to avoid loading hundreds of MB into memory
      return {
        stats: quickStats,
        perFileStats: new Map(),
        hunks: new Map(),
      }
    }
  }

  // Get stats via --numstat (all uncommitted changes vs HEAD)
  const { stdout: numstatOut, code: numstatCode } = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--numstat'],
    cwd,
  )

  if (numstatCode !== 0) return null

  const { stats, perFileStats } = parseGitNumstat(numstatOut)

  // Include untracked files (new files not yet staged)
  // Just filenames - no content reading for performance
  const remainingSlots = MAX_FILES - perFileStats.size
  if (remainingSlots > 0) {
    const untrackedStats = await fetchUntrackedFiles(remainingSlots, cwd)
    if (untrackedStats) {
      stats.filesCount += untrackedStats.size
      for (const [path, fileStats] of untrackedStats) {
        perFileStats.set(path, fileStats)
      }
    }
  }

  // Return stats only - hunks are fetched on-demand via fetchGitDiffHunks()
  // to avoid expensive git diff HEAD call on every poll
  return { stats, perFileStats, hunks: new Map() }
}

/**
 * Fetch git diff hunks on-demand (for DiffDialog).
 * Separated from fetchGitDiff() to avoid expensive calls during polling.
 */
export async function fetchGitDiffHunks(
  cwd?: string,
): Promise<Map<string, StructuredPatchHunk[]>> {
  if (!cwd && !(await getIsGit())) return new Map()

  if (await isInTransientGitState(cwd)) {
    return new Map()
  }

  // Force standard a/ b/ prefixes so parseGitDiff matches regardless of the
  // user's diff.mnemonicPrefix / diff.noprefix git config.
  const { stdout: diffOut, code: diffCode } = await runGit(
    ['--no-optional-locks', 'diff', 'HEAD', '--src-prefix=a/', '--dst-prefix=b/'],
    cwd,
  )

  if (diffCode !== 0) {
    return new Map()
  }

  return parseGitDiff(diffOut)
}

export type NumstatResult = {
  stats: GitDiffStats
  perFileStats: Map<string, PerFileStats>
}

/**
 * Parse git diff --numstat output into stats.
 * Format: <added>\t<removed>\t<filename>
 * Binary files show '-' for counts.
 * Only stores first MAX_FILES entries in perFileStats.
 */
export function parseGitNumstat(stdout: string): NumstatResult {
  const lines = stdout.trim().split('\n').filter(Boolean)
  let added = 0
  let removed = 0
  let validFileCount = 0
  const perFileStats = new Map<string, PerFileStats>()

  for (const line of lines) {
    const parts = line.split('\t')
    // Valid numstat lines have exactly 3 tab-separated parts: added, removed, filename
    if (parts.length < 3) continue

    validFileCount++
    const addStr = parts[0]
    const remStr = parts[1]
    const rawPath = parts.slice(2).join('\t') // filename may contain tabs
    // Resolve rename forms ("old => new", "src/{old => new}/f") to the new
    // path so this key matches parseGitDiff's hunk key (which uses b/<new>).
    const { path: filePath, renamedFrom } = parseRenamePath(rawPath)
    const isBinary = addStr === '-' || remStr === '-'
    const fileAdded = isBinary ? 0 : parseInt(addStr ?? '0', 10) || 0
    const fileRemoved = isBinary ? 0 : parseInt(remStr ?? '0', 10) || 0

    added += fileAdded
    removed += fileRemoved

    // Only store first MAX_FILES entries
    if (perFileStats.size < MAX_FILES) {
      perFileStats.set(filePath, {
        added: fileAdded,
        removed: fileRemoved,
        isBinary,
        ...(renamedFrom ? { renamedFrom } : {}),
      })
    }
  }

  return {
    stats: {
      filesCount: validFileCount,
      linesAdded: added,
      linesRemoved: removed,
    },
    perFileStats,
  }
}

/**
 * Parse unified diff output into per-file hunks.
 * Splits by "diff --git" and parses each file's hunks.
 *
 * Applies limits:
 * - MAX_FILES: stop after this many files
 * - Files >1MB: skipped entirely (not in result map)
 * - Files ≤1MB: parsed but limited to MAX_LINES_PER_FILE lines
 */
export function parseGitDiff(
  stdout: string,
): Map<string, StructuredPatchHunk[]> {
  const result = new Map<string, StructuredPatchHunk[]>()
  if (!stdout.trim()) return result

  // Split by file diffs
  const fileDiffs = stdout.split(/^diff --git /m).filter(Boolean)

  for (const fileDiff of fileDiffs) {
    // Stop after MAX_FILES
    if (result.size >= MAX_FILES) break

    // Skip files larger than 1MB. Measure actual UTF-8 bytes, not
    // string.length (UTF-16 code units) — a multibyte (e.g. CJK) diff of
    // several real MB has a much smaller .length and would slip past the cap.
    if (Buffer.byteLength(fileDiff, 'utf8') > MAX_DIFF_SIZE_BYTES) {
      continue
    }

    const lines = fileDiff.split('\n')

    // Extract filename from first line: "a/path/to/file b/path/to/file".
    // The single-char prefix is matched loosely (`.`) so mnemonic prefixes
    // (c/w, i/w, o/w) still parse if a caller didn't force a/ b/.
    const headerMatch = lines[0]?.match(/^.\/(.+?) .\/(.+)$/)
    if (!headerMatch) continue
    const filePath = headerMatch[2] ?? headerMatch[1] ?? ''

    // Find and parse hunks
    const fileHunks: StructuredPatchHunk[] = []
    let currentHunk: StructuredPatchHunk | null = null
    let lineCount = 0

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''

      // StructuredPatchHunk header: @@ -oldStart,oldLines +newStart,newLines @@
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
      )
      if (hunkMatch) {
        if (currentHunk) {
          fileHunks.push(currentHunk)
        }
        currentHunk = {
          oldStart: parseInt(hunkMatch[1] ?? '0', 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3] ?? '0', 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
          lines: [],
        }
        continue
      }

      // Skip binary file markers and other metadata
      if (
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('Binary files')
      ) {
        continue
      }

      // Add diff lines to current hunk (with line limit)
      if (
        currentHunk &&
        (line.startsWith('+') ||
          line.startsWith('-') ||
          line.startsWith(' ') ||
          line === '')
      ) {
        // Stop adding lines once we hit the limit
        if (lineCount >= MAX_LINES_PER_FILE) {
          continue
        }
        // Force a flat string copy to break V8 sliced string references.
        // When split() creates lines, V8 creates "sliced strings" that reference
        // the parent. This keeps the entire parent string (~MBs) alive as long as
        // any line is retained. Using '' + line forces a new flat string allocation,
        // unlike slice(0) which V8 may optimize to return the same reference.
        currentHunk.lines.push('' + line)
        lineCount++
      }
    }

    // Don't forget the last hunk
    if (currentHunk) {
      fileHunks.push(currentHunk)
    }

    if (fileHunks.length > 0) {
      result.set(filePath, fileHunks)
    }
  }

  return result
}

/**
 * Build a single all-added hunk from a new/untracked file's full content, so
 * the reviewer can show it as an all-green diff. `git diff HEAD` omits
 * untracked files, so they otherwise have no hunks at all. Mirrors
 * parseGitDiff's hunk shape: lines are '+'-prefixed and flat-copied (`'' + l`)
 * to break V8 sliced-string references, and capped at MAX_LINES_PER_FILE.
 */
export function buildAddedFileHunks(content: string): StructuredPatchHunk[] {
  if (!content) return []
  const lines = content.split('\n')
  // Drop the trailing empty element from a final newline so we don't render a
  // phantom blank added line at EOF.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const added = lines.slice(0, MAX_LINES_PER_FILE).map(l => '+' + l)
  if (added.length === 0) return []
  return [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: added.length, lines: added },
  ]
}

/**
 * Check if we're in a transient git state (merge, rebase, cherry-pick, or revert).
 * During these operations, we skip diff calculation since the working
 * tree contains incoming changes that weren't intentionally made.
 *
 * Uses fs.access to check for transient ref files, avoiding process spawns.
 */
async function isInTransientGitState(cwd?: string): Promise<boolean> {
  const gitDir = await getGitDir(cwd ?? getCwd())
  if (!gitDir) return false

  const transientFiles = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
  ]

  const results = await Promise.all(
    transientFiles.map(file =>
      access(join(gitDir, file))
        .then(() => true)
        .catch(() => false),
    ),
  )
  return results.some(Boolean)
}

/**
 * Fetch untracked file names (no content reading).
 * Returns file paths only - they'll be displayed with a note to stage them.
 *
 * @param maxFiles Maximum number of untracked files to include
 */
async function fetchUntrackedFiles(
  maxFiles: number,
  cwd?: string,
): Promise<Map<string, PerFileStats> | null> {
  // Get list of untracked files (excludes gitignored)
  const { stdout, code } = await runGit(
    ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
    cwd,
  )

  if (code !== 0 || !stdout.trim()) return null

  const untrackedPaths = stdout.trim().split('\n').filter(Boolean)
  if (untrackedPaths.length === 0) return null

  const perFileStats = new Map<string, PerFileStats>()

  // Just record filenames, no content reading
  for (const filePath of untrackedPaths.slice(0, maxFiles)) {
    perFileStats.set(filePath, {
      added: 0,
      removed: 0,
      isBinary: false,
      isUntracked: true,
    })
  }

  return perFileStats
}

/**
 * Parse git diff --shortstat output into stats.
 * Format: " 1648 files changed, 52341 insertions(+), 8123 deletions(-)"
 *
 * This is O(1) memory regardless of diff size - git computes totals without
 * loading all content. Used as a quick probe before expensive operations.
 */
export function parseShortstat(stdout: string): GitDiffStats | null {
  // Match: "N files changed" with optional ", N insertions(+)" and ", N deletions(-)"
  const match = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  )
  if (!match) return null
  return {
    filesCount: parseInt(match[1] ?? '0', 10),
    linesAdded: parseInt(match[2] ?? '0', 10),
    linesRemoved: parseInt(match[3] ?? '0', 10),
  }
}

const SINGLE_FILE_DIFF_TIMEOUT_MS = 3000

/** Short leash: this runs on a footer poll, so a slow repo must not pile up. */
const SHORTSTAT_TIMEOUT_MS = 2000

export type DiffStatSummary = {
  /**
   * Working tree + index vs HEAD. Tracked files only — `git diff` cannot see
   * an untracked file, so a brand-new file counts zero here until it is added.
   */
  uncommitted: GitDiffStats | null
  /**
   * Merge-base with the default branch → working tree, i.e. everything this
   * branch carries over its base, committed and not. Null while HEAD sits on
   * the base branch, where merge-base IS HEAD and this would only repeat
   * `uncommitted`; the two are mutually exclusive, never both set.
   */
  branch: GitDiffStats | null
  /** Display label for the branch comparison's base (e.g. `main`). */
  branchBase: string | null
}

const EMPTY_DIFF_STAT_SUMMARY: DiffStatSummary = {
  uncommitted: null,
  branch: null,
  branchBase: null,
}

/** Which single `git diff` the readout needs, and what to label it. */
export type DiffStatScope =
  | { kind: 'branch'; against: string; base: string }
  | { kind: 'uncommitted' }

/**
 * Pick the one comparison worth running, given HEAD and its merge-base with
 * the default branch. Split out from the plumbing because it is the only real
 * decision here and it has three collapsing cases: merge-base failed (detached
 * HEAD, shallow clone, no such base), merge-base IS HEAD (sitting on the base
 * branch), or a branch that has actually diverged. Only the last is worth
 * diffing against anything but HEAD — in the others `diff <mergeBase>` and
 * `diff HEAD` are the same command spelled differently.
 *
 * Compares SHAs rather than the resulting line counts: `+8 -1` measured from
 * two different refs can coincide, and collapsing on that would silently
 * relabel a real branch total as merely uncommitted.
 */
export function chooseDiffStatScope(
  head: string,
  mergeBase: string | null,
  base: string,
): DiffStatScope {
  if (!mergeBase || !head || mergeBase === head) return { kind: 'uncommitted' }
  return { kind: 'branch', against: mergeBase, base }
}

/**
 * One `--shortstat` probe for the prompt's diff readout, plus the merge-base
 * lookup that decides which one to take. `--shortstat` is O(1) in memory — git
 * totals without materializing the diff — and measures in single milliseconds
 * warm, which is what makes it affordable on a poll.
 *
 * Fails open: every git failure degrades to reporting less, never to throwing
 * on the render path.
 */
export async function fetchDiffStatSummary(): Promise<DiffStatSummary> {
  if (!(await getIsGit())) return EMPTY_DIFF_STAT_SUMMARY
  const gitRoot = findGitRoot(getCwd())
  if (!gitRoot) return EMPTY_DIFF_STAT_SUMMARY

  // Same base resolution as the /diff reviewer (getDiffRef), so the footer and
  // the reviewer never disagree about what "the branch" means.
  const base = process.env.CLAUDE_CODE_BASE_REF || (await getDefaultBranch())
  const [head, mergeBase] = await Promise.all([
    getHead(),
    runGit(
      ['--no-optional-locks', 'merge-base', 'HEAD', base],
      gitRoot,
      SHORTSTAT_TIMEOUT_MS,
    ),
  ])
  const scope = chooseDiffStatScope(
    head.trim(),
    mergeBase.code === 0 ? mergeBase.stdout.trim() : null,
    base,
  )

  const diff = await runGit(
    [
      '--no-optional-locks',
      'diff',
      '--shortstat',
      scope.kind === 'branch' ? scope.against : 'HEAD',
    ],
    gitRoot,
    SHORTSTAT_TIMEOUT_MS,
  )
  const stats = diff.code === 0 ? parseShortstat(diff.stdout) : null
  if (!stats) return EMPTY_DIFF_STAT_SUMMARY
  return scope.kind === 'branch'
    ? { uncommitted: null, branch: stats, branchBase: scope.base }
    : { uncommitted: stats, branch: null, branchBase: null }
}

export type ToolUseDiff = {
  filename: string
  status: 'modified' | 'added'
  additions: number
  deletions: number
  changes: number
  patch: string
  /** GitHub "owner/repo" when available (null for non-github.com or unknown repos) */
  repository: string | null
}

/**
 * Fetch a structured diff for a single file against the merge base with the
 * default branch. This produces a PR-like diff showing all changes since
 * the branch diverged. Falls back to diffing against HEAD if the merge base
 * cannot be determined (e.g., on the default branch itself).
 * For untracked files, generates a synthetic diff showing all additions.
 * Returns null if not in a git repo or if git commands fail.
 */
export async function fetchSingleFileGitDiff(
  absoluteFilePath: string,
): Promise<ToolUseDiff | null> {
  const gitRoot = findGitRoot(dirname(absoluteFilePath))
  if (!gitRoot) return null

  const gitPath = relative(gitRoot, absoluteFilePath).split(sep).join('/')
  const repository = getCachedRepository()

  // Check if the file is tracked by git
  const { code: lsFilesCode } = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'ls-files', '--error-unmatch', gitPath],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )

  if (lsFilesCode === 0) {
    // File is tracked - diff against merge base for PR-like view
    const diffRef = await getDiffRef(gitRoot)
    const { stdout, code } = await execFileNoThrowWithCwd(
      gitExe(),
      ['--no-optional-locks', 'diff', diffRef, '--', gitPath],
      { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
    )
    if (code !== 0) return null
    if (!stdout) return null
    return {
      ...parseRawDiffToToolUseDiff(gitPath, stdout, 'modified'),
      repository,
    }
  }

  // File is untracked - generate synthetic diff
  const syntheticDiff = await generateSyntheticDiff(gitPath, absoluteFilePath)
  if (!syntheticDiff) return null
  return { ...syntheticDiff, repository }
}

/**
 * Parse raw unified diff output into the structured ToolUseDiff format.
 * Extracts only the hunk content (starting from @@) as the patch,
 * and counts additions/deletions.
 */
function parseRawDiffToToolUseDiff(
  filename: string,
  rawDiff: string,
  status: 'modified' | 'added',
): Omit<ToolUseDiff, 'repository'> {
  const lines = rawDiff.split('\n')
  const patchLines: string[] = []
  let inHunks = false
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunks = true
    }
    if (inHunks) {
      patchLines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++
      }
    }
  }

  return {
    filename,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch: patchLines.join('\n'),
  }
}

/**
 * Determine the best ref to diff against for a PR-like diff.
 * Priority:
 * 1. CLAUDE_CODE_BASE_REF env var (set externally, e.g. by CCR managed containers)
 * 2. Merge base with the default branch (best guess)
 * 3. HEAD (fallback if merge-base fails)
 */
async function getDiffRef(gitRoot: string): Promise<string> {
  const baseBranch =
    process.env.CLAUDE_CODE_BASE_REF || (await getDefaultBranch())
  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'merge-base', 'HEAD', baseBranch],
    { cwd: gitRoot, timeout: SINGLE_FILE_DIFF_TIMEOUT_MS },
  )
  if (code === 0 && stdout.trim()) {
    return stdout.trim()
  }
  return 'HEAD'
}

async function generateSyntheticDiff(
  gitPath: string,
  absoluteFilePath: string,
): Promise<Omit<ToolUseDiff, 'repository'> | null> {
  try {
    if (!isFileWithinReadSizeLimit(absoluteFilePath, MAX_DIFF_SIZE_BYTES)) {
      return null
    }
    const content = await readFile(absoluteFilePath, 'utf-8')
    const lines = content.split('\n')
    // Remove trailing empty line from split if file ends with newline
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop()
    }
    const lineCount = lines.length
    const addedLines = lines.map(line => `+${line}`).join('\n')
    const patch = `@@ -0,0 +1,${lineCount} @@\n${addedLines}`
    return {
      filename: gitPath,
      status: 'added',
      additions: lineCount,
      deletions: 0,
      changes: lineCount,
      patch,
    }
  } catch {
    return null
  }
}
