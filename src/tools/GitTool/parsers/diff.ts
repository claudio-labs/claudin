/**
 * Unified-diff rendering for `git diff` and the diff half of `git show`.
 *
 * Two levers, in the order the corpus says they pay:
 *
 *  1. **Pivot.** Above a size threshold the hunks are dropped entirely and a
 *     stat table takes their place, with the command that fetches one file's
 *     hunks back. Measured over 760 recorded sessions, the addressable `git
 *     diff` bodies are overwhelmingly SINGLE-FILE (43 of 83), so a file-count
 *     pivot in the shape of Grep's would fire on almost nothing — bodies at or
 *     above 6 KB hold 59.5% of all unified-diff chars while diffs of five or
 *     more files hold under 10%. The threshold is therefore on SIZE, and the
 *     file count is only a secondary trigger.
 *
 *     Swept over the addressable corpus (59 unified bodies, 268,862 chars),
 *     the pivot alone takes 45.3% at 6 KB, 54.0% at 4 KB and 60.4% at 3 KB.
 *     6 KB is a deliberate safety margin, not the maximum: 3 KB is roughly 75
 *     lines, which a model can simply read, and throwing its hunks away to
 *     save chars would trade a real answer for a table.
 *  2. **Per-file line budget.** Below the pivot, whole hunks are kept until a
 *     per-file budget is spent and the remainder is named rather than shown.
 *     Hunks are never cut in half: a truncated hunk is unreadable, and the
 *     model would just re-request the file.
 *
 * `parseGitDiff` (src/services/git/gitDiff.ts) supplies the hunk structure. The
 * add/remove counts are counted here from the raw section instead of from its
 * hunks, because it caps at 400 lines per file — counts derived from capped
 * hunks would silently understate a large file, and a WRONG stat table is worse
 * than no summary at all.
 */
import type { StructuredPatchHunk } from 'diff'

import { parseGitDiff } from 'src/services/git/gitDiff.js'

/** Bodies at or above this many chars lose their hunks. */
export const DIFF_PIVOT_CHARS = 6_000
/** …as do bodies touching at least this many files. */
export const DIFF_PIVOT_FILES = 6
/**
 * Per-file line budget below the pivot.
 *
 * Sized so it actually does work in the band the pivot skips. The corpus band
 * between 2 KB and 6 KB holds ~31% of unified-diff chars, and a budget of 120
 * lines (~5 KB) sat above almost all of it — the pivot fired first every time
 * and this arm was close to dead code. 60 lines is roughly 2.5 KB, which is
 * where that band starts.
 */
export const DIFF_FILE_LINE_BUDGET = 60

const FILE_SPLIT_RE = /^diff --git /m
const HEADER_PATH_RE = /^.\/(.+?) .\/(.+)$/
/**
 * The Bash output filter strips `diff --git` header lines (13 of 95 recorded
 * diff bodies arrive that way), leaving the `--- a/x` / `+++ b/x` pair as the
 * only file boundary. Splitting on that pair is the fallback.
 */
const MINUS_HEADER_SPLIT_RE = /^--- /m
const PLUS_HEADER_RE = /^\+\+\+ (?:.\/)?(.+)$/m
/**
 * Multiline on purpose. The Bash output filter strips the `diff --git` and
 * `index` headers, so for most users the FIRST thing in a diff is `--- a/…`
 * and the only proof it is a diff is a hunk header partway down. Without the
 * `m` this matched at position 0 only, `isUnifiedDiff` said no, and the diff
 * budget quietly never fired on a filtered diff — which is the default
 * configuration. `summarizeDiffFiles` has always handled the headerless shape;
 * this is what lets it be reached.
 */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m
const BINARY_RE = /^Binary files /m
const NEW_FILE_RE = /^new file mode /m
const DELETED_FILE_RE = /^deleted file mode /m
const RENAME_FROM_RE = /^rename from (.+)$/m

export type DiffFileSummary = {
  path: string
  added: number
  removed: number
  isBinary: boolean
  isNew: boolean
  isDeleted: boolean
  renamedFrom?: string
}

/** True when the text looks like a unified diff rather than `--stat` output. */
export function isUnifiedDiff(text: string): boolean {
  return text.includes('diff --git ') || HUNK_HEADER_RE.test(text)
}

/**
 * Exact per-file counts, straight off the raw section. A `+++`/`---` header
 * line starts with the same character as a content line, so both are skipped
 * explicitly.
 */
function summarizeSection(section: string): DiffFileSummary | null {
  const lines = section.split('\n')
  const header = lines[0]?.match(HEADER_PATH_RE)
  if (!header) return null
  const path = header[2] ?? header[1] ?? ''

  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }

  const renamed = section.match(RENAME_FROM_RE)
  return {
    path,
    added,
    removed,
    isBinary: BINARY_RE.test(section),
    isNew: NEW_FILE_RE.test(section),
    isDeleted: DELETED_FILE_RE.test(section),
    ...(renamed?.[1] ? { renamedFrom: renamed[1] } : {}),
  }
}

/**
 * Counts for a section whose `diff --git` line the output filter removed.
 *
 * The `+++` header must be on the line straight after the split point. A
 * removed content line that happens to start with `--- ` also splits, and
 * accepting it would put a phantom path in the stat table — a stat table that
 * lies is worse than no summary.
 */
function summarizeHeaderlessSection(section: string): DiffFileSummary | null {
  const second = section.split('\n', 2)[1]
  if (second === undefined || !second.startsWith('+++ ')) return null
  const plus = section.match(PLUS_HEADER_RE)
  if (!plus?.[1]) return null
  let added = 0
  let removed = 0
  for (const line of section.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return {
    path: plus[1],
    added,
    removed,
    isBinary: BINARY_RE.test(section),
    isNew: false,
    isDeleted: false,
  }
}

export function summarizeDiffFiles(text: string): DiffFileSummary[] {
  const out: DiffFileSummary[] = []
  if (text.includes('diff --git ')) {
    for (const section of text.split(FILE_SPLIT_RE)) {
      if (!section.trim()) continue
      const summary = summarizeSection(section)
      if (summary) out.push(summary)
    }
    return out
  }
  for (const section of text.split(MINUS_HEADER_SPLIT_RE)) {
    if (!section.trim()) continue
    const summary = summarizeHeaderlessSection(section)
    if (summary) out.push(summary)
  }
  return out
}

function tag(file: DiffFileSummary): string {
  if (file.isBinary) return ' (binary)'
  if (file.isNew) return ' (new)'
  if (file.isDeleted) return ' (deleted)'
  if (file.renamedFrom) return ` (renamed from ${file.renamedFrom})`
  return ''
}

function statLine(file: DiffFileSummary): string {
  return `  ${file.path}  +${file.added}/-${file.removed}${tag(file)}`
}

function hunkText(hunk: StructuredPatchHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return [header, ...hunk.lines].join('\n')
}

/** The stat table, i.e. what a pivoted diff returns instead of hunks. */
export function renderDiffStat(
  files: readonly DiffFileSummary[],
  reason: string,
): string {
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const noun = files.length === 1 ? 'file' : 'files'
  return [
    `${files.length} ${noun} changed, +${added}/-${removed} (${reason} — hunks omitted)`,
    ...files.map(statLine),
    `Ask for one file's hunks with Git({commands:["git diff -- <path>"]}), or for all of them at once by re-sending this command with full: true.`,
  ].join('\n')
}

/**
 * Keep whole hunks until the per-file budget is spent, then name what is left.
 * Returns null when nothing was dropped, so the caller can tell a real saving
 * from a no-op.
 */
function renderFileBudgeted(
  file: DiffFileSummary,
  hunks: readonly StructuredPatchHunk[],
): { text: string; elided: boolean } {
  const kept: string[] = []
  let lines = 0
  let dropped = 0
  let droppedLines = 0

  for (const hunk of hunks) {
    if (lines > 0 && lines + hunk.lines.length > DIFF_FILE_LINE_BUDGET) {
      dropped++
      droppedLines += hunk.lines.length
      continue
    }
    kept.push(hunkText(hunk))
    lines += hunk.lines.length
  }

  const head = `${file.path}  +${file.added}/-${file.removed}${tag(file)}`
  if (dropped === 0) return { text: [head, ...kept].join('\n'), elided: false }
  const noun = dropped === 1 ? 'hunk' : 'hunks'
  return {
    text: [
      head,
      ...kept,
      `  … ${dropped} more ${noun} (${droppedLines} lines) — Git({commands:["git diff -- ${file.path}"]}), or full: true, for the rest.`,
    ].join('\n'),
    elided: true,
  }
}

/**
 * @returns a budgeted rendering, or null when this body is not a unified diff
 * or has nothing worth eliding.
 */
export function renderDiff(text: string): string | null {
  if (!isUnifiedDiff(text)) return null
  const files = summarizeDiffFiles(text)
  if (files.length === 0) return null

  if (text.length >= DIFF_PIVOT_CHARS || files.length >= DIFF_PIVOT_FILES) {
    const reason =
      files.length >= DIFF_PIVOT_FILES
        ? `${files.length} files`
        : `${Math.round(text.length / 1000)}k of diff`
    return renderDiffStat(files, reason)
  }

  const hunksByPath = parseGitDiff(text)
  const sections: string[] = []
  let anyElided = false
  for (const file of files) {
    const hunks = hunksByPath.get(file.path)
    if (!hunks || hunks.length === 0) {
      sections.push(`${file.path}  +${file.added}/-${file.removed}${tag(file)}`)
      continue
    }
    const rendered = renderFileBudgeted(file, hunks)
    if (rendered.elided) anyElided = true
    sections.push(rendered.text)
  }
  // Nothing was dropped: the raw diff is already within budget, and re-rendering
  // it would only strip context the model may want. Decline instead.
  if (!anyElided) return null
  return sections.join('\n\n')
}
