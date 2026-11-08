// Reverting one hunk of the working tree from /diff. Only the working-tree
// source can do it: its hunks are `git diff HEAD` (gitDiff.ts), so the hunk
// is a well-defined patch against the file on disk and `git apply -R` takes
// it back. A turn's hunks are edit-time patches with no anchor to the file as
// it is now, so /diff points those at the working tree instead.
//
// The hunk is re-read from a fresh `git diff HEAD -- <path>` before anything
// is written: /diff's parsed hunks drop the `\ No newline at end of file`
// markers git needs, and a hunk that is no longer in the diff means the file
// moved since the view was taken. The revert touches the working tree only. A
// file with staged changes is refused, because the index would still hold
// what the working tree lost, and the next commit would bring it back. So are
// the shapes a single hunk cannot carry: new, deleted, renamed and binary
// files, and diffs cut at the line cap.
import type { StructuredPatchHunk } from 'diff'
import { gitExe } from 'src/vcs/git/git.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'

export type RevertableFile = Pick<
  DiffFile,
  'path' | 'isBinary' | 'isLargeFile' | 'isTruncated' | 'isNewFile' | 'isUntracked' | 'renamedFrom'
>

export type RevertResult = { ok: true } | { ok: false; reason: string }

/** What `x` in /diff does: ask to revert a hunk, or say why it can't. */
export type RevertIntent =
  | { kind: 'confirm'; hunk: StructuredPatchHunk; question: string }
  | { kind: 'notice'; text: string }

/** Runs git in `cwd`, feeding `input` on stdin; the seam tests drive. */
export type RunGit = (
  args: string[],
  cwd: string,
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>

const GIT_TIMEOUT_MS = 10_000
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const HUNK_LINE_RE = /^[ +\-\\]/
const GIT_ERROR_PREFIX_RE = /^error:\s*/

const runGit: RunGit = (args, cwd, input) =>
  execFileNoThrowWithCwd(gitExe(), args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(input !== undefined && { input }),
  })

/** Why this hunk cannot be reverted on its own, or `null` when it can. */
export function revertBlocker(
  file: RevertableFile,
  hunk: StructuredPatchHunk,
): string | null {
  if (file.isBinary) return 'binary files cannot be reverted hunk by hunk'
  if (file.isUntracked || file.isNewFile || (hunk.oldStart === 0 && hunk.oldLines === 0)) {
    return 'a new file has no earlier version to go back to'
  }
  if (hunk.newStart === 0 && hunk.newLines === 0) {
    return 'a deleted file cannot be restored hunk by hunk'
  }
  if (file.renamedFrom) return 'renamed files cannot be reverted hunk by hunk'
  if (file.isLargeFile || file.isTruncated) {
    return "this file's diff is truncated, so the hunk may be incomplete"
  }
  return null
}

const ON_A_HUNK = 'move the cursor onto a changed hunk to revert it'

/**
 * The decision behind `x`: `source` is the active /diff source, `hunks` the
 * selected file's real hunks, `atCursor` the hunk segment under the cursor
 * (rowLines.hunkAtRow) — a context hunk a gap reveal synthesized is not one
 * of `hunks`, and is not revertable.
 */
export function planHunkRevert(
  source: 'working' | 'turn' | 'stash',
  file: RevertableFile | null,
  hunks: readonly StructuredPatchHunk[],
  atCursor: StructuredPatchHunk | null,
): RevertIntent {
  if (source !== 'working') {
    return { kind: 'notice', text: 'switch the source to the working tree to revert a hunk' }
  }
  if (!file || !atCursor) return { kind: 'notice', text: ON_A_HUNK }
  const blocker = revertBlocker(file, atCursor)
  if (blocker) return { kind: 'notice', text: `can't revert: ${blocker}` }
  if (!hunks.includes(atCursor)) return { kind: 'notice', text: ON_A_HUNK }
  const added = atCursor.lines.filter(l => l.startsWith('+')).length
  const removed = atCursor.lines.filter(l => l.startsWith('-')).length
  return {
    kind: 'confirm',
    hunk: atCursor,
    question: `Revert the hunk at line ${firstChangedLine(atCursor)} (+${added} -${removed})?`,
  }
}

/** The new-file line of the hunk's first change: its leading context skipped. */
function firstChangedLine(hunk: StructuredPatchHunk): number {
  let line = hunk.newStart
  for (const raw of hunk.lines) {
    if (raw.startsWith('+') || raw.startsWith('-')) break
    line += 1
  }
  return line
}

/** One file's hunks as git prints them, `\ No newline at end of file` markers kept. */
export function parseRawHunks(diff: string): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = []
  let current: StructuredPatchHunk | null = null
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER_RE.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
    } else if (current && HUNK_LINE_RE.test(line)) {
      current.lines.push(line)
    }
  }
  return hunks
}

/** The lines that say what a hunk changes: no markers, no blank split artifacts. */
const changeLines = (hunk: StructuredPatchHunk): string[] =>
  hunk.lines.filter(line => line !== '' && !line.startsWith('\\'))

function sameHunk(a: StructuredPatchHunk, b: StructuredPatchHunk): boolean {
  if (
    a.oldStart !== b.oldStart ||
    a.oldLines !== b.oldLines ||
    a.newStart !== b.newStart ||
    a.newLines !== b.newLines
  ) {
    return false
  }
  const x = changeLines(a)
  const y = changeLines(b)
  return x.length === y.length && x.every((line, i) => line === y[i])
}

/** `hunk` of `path` as a unified diff `git apply` reads (a/ b/ prefixes, -p1). */
export function singleHunkPatch(path: string, hunk: StructuredPatchHunk): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
    '',
  ].join('\n')
}

/** First line of git's complaint, for the status line. */
function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0]?.replace(GIT_ERROR_PREFIX_RE, '') ?? ''
}

const MOVED = 'the file changed since the diff was taken'

/**
 * Takes `hunk` back out of `file` in the working tree of `repoRoot`. The hunk
 * must still be in the file's diff, and `git apply -R --check` must accept it,
 * before anything is written; otherwise the file is left as it is and the
 * reason comes back.
 */
export async function revertHunk(
  repoRoot: string,
  file: RevertableFile,
  hunk: StructuredPatchHunk,
  run: RunGit = runGit,
): Promise<RevertResult> {
  const blocker = revertBlocker(file, hunk)
  if (blocker) return { ok: false, reason: blocker }

  const staged = await run(['diff', '--cached', '--quiet', '--', file.path], repoRoot)
  if (staged.code !== 0) {
    return { ok: false, reason: `${file.path} has staged changes — unstage it first` }
  }

  const diff = await run(
    ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--', file.path],
    repoRoot,
  )
  const fresh = diff.code === 0 ? parseRawHunks(diff.stdout).find(h => sameHunk(h, hunk)) : undefined
  if (!fresh) return { ok: false, reason: MOVED }

  const patch = singleHunkPatch(file.path, fresh)
  const check = await run(['apply', '-R', '--check', '--recount', '-'], repoRoot, patch)
  if (check.code !== 0) {
    const why = firstLine(check.stderr)
    return { ok: false, reason: why ? `${MOVED} (${why})` : MOVED }
  }
  const applied = await run(['apply', '-R', '--recount', '-'], repoRoot, patch)
  if (applied.code !== 0) {
    return { ok: false, reason: firstLine(applied.stderr) || 'git apply failed' }
  }
  return { ok: true }
}
