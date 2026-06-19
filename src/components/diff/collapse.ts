import type { StructuredPatchHunk } from 'diff'
import type { DiffSegment } from './types.js'

/**
 * Build the collapsible render model for a file's hunks. Unchanged stretches
 * between/around hunks become `gap` segments (rendered as `··· N lines`
 * markers); revealed portions become synthetic context-only hunks spliced from
 * the working-tree file text, so they render through the same `StructuredDiff`
 * path (identical theme colors / syntax highlighting) as real hunks.
 *
 * Pure. Fail-open: when `fileContent` is unavailable (binary / large / deleted
 * / non-working-tree source) it returns the hunks as-is with no gap markers,
 * preserving today's behavior.
 *
 * @param hunks      parsed diff hunks (new-file line numbering in newStart)
 * @param fileContent full new-file text, or undefined to disable collapsing
 * @param revealed   per-gap revealed line count, keyed by the gap's stable id
 * @param expandAll  reveal every gap fully (the `a` key)
 */
export function buildDiffRenderModel(
  hunks: StructuredPatchHunk[],
  fileContent: string | undefined,
  revealed: ReadonlyMap<string, number> = new Map(),
  expandAll = false,
): DiffSegment[] {
  if (hunks.length === 0) return []
  if (fileContent === undefined) {
    return hunks.map(hunk => ({ kind: 'hunk', hunk }))
  }

  const fileLines = fileContent.split('\n')
  // A file ending in a newline yields a phantom empty final element; drop it so
  // the tail gap doesn't reveal a spurious blank context line past EOF.
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
    fileLines.pop()
  }
  const totalNewLines = fileLines.length

  // Each context-only region carries both old and new start lines: in an
  // unchanged stretch old and new advance together, so we can render correct
  // gutter numbers.
  type Gap = { oldStart: number; newStart: number; count: number }

  const contextHunk = (gap: Gap, count: number): StructuredPatchHunk => {
    const safeCount = Math.max(
      0,
      Math.min(count, totalNewLines - (gap.newStart - 1)),
    )
    const lines: string[] = []
    for (let i = 0; i < safeCount; i++) {
      // ' ' prefix = unchanged/context line, matching unified-diff hunk lines.
      lines.push(' ' + (fileLines[gap.newStart - 1 + i] ?? ''))
    }
    return {
      oldStart: gap.oldStart,
      oldLines: safeCount,
      newStart: gap.newStart,
      newLines: safeCount,
      lines,
    }
  }

  const segments: DiffSegment[] = []

  const emitGap = (gap: Gap): void => {
    if (gap.count <= 0) return
    const id = `gap@${gap.newStart}`
    const reveal = expandAll
      ? gap.count
      : Math.max(0, Math.min(revealed.get(id) ?? 0, gap.count))

    if (reveal <= 0) {
      segments.push({
        kind: 'gap',
        id,
        startLine: gap.newStart,
        lineCount: gap.count,
      })
      return
    }
    if (reveal >= gap.count) {
      segments.push({ kind: 'hunk', hunk: contextHunk(gap, gap.count) })
      return
    }
    // Partial reveal grows from the top of the gap; the remainder stays a
    // marker but keeps the original gap id so reveal state survives re-render.
    segments.push({ kind: 'hunk', hunk: contextHunk(gap, reveal) })
    segments.push({
      kind: 'gap',
      id,
      startLine: gap.newStart + reveal,
      lineCount: gap.count - reveal,
    })
  }

  // Head gap: unchanged lines before the first hunk (old/new both start at 1).
  const first = hunks[0]!
  emitGap({ oldStart: 1, newStart: 1, count: first.newStart - 1 })

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!
    segments.push({ kind: 'hunk', hunk })

    const newEnd = hunk.newStart + hunk.newLines
    const oldEnd = hunk.oldStart + hunk.oldLines
    const next = hunks[i + 1]
    if (next) {
      emitGap({
        oldStart: oldEnd,
        newStart: newEnd,
        count: next.newStart - newEnd,
      })
    } else {
      // Tail gap: from after the last hunk to end of file.
      emitGap({
        oldStart: oldEnd,
        newStart: newEnd,
        count: totalNewLines - newEnd + 1,
      })
    }
  }

  return segments
}
