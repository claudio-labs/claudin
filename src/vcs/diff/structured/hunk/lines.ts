import type { StructuredPatchHunk } from 'diff'

/**
 * What a hunk line is. A `note` is the `\ No newline at end of file` line,
 * which is not code: it qualifies the line above it.
 */
export type LineKind = 'added' | 'removed' | 'context' | 'note'

/** The character a hunk line of each kind starts with, which its row shows in the marker column. */
export const LINE_MARKERS: Readonly<Record<LineKind, string>> = { added: '+', removed: '-', context: ' ', note: '\\' }

/** A hunk line as it is drawn: its kind, its code, and its number (a note has none). */
export type HunkLine = { kind: LineKind; code: string; number: number | null }

/** A note, and the index among the hunk's lines of code of the line it follows (-1 when none does). */
export type HunkNote = { code: string; after: number }

/**
 * Reads a hunk's lines and numbers them the way the syntax renderer does: a
 * removed line by the old file, every other line by the new one. A note takes
 * no number and does not move the count. A line with any other first
 * character is context.
 */
export function readHunkLines(hunk: StructuredPatchHunk): HunkLine[] {
  let oldNumber = hunk.oldStart
  let newNumber = hunk.newStart
  return hunk.lines.map((line): HunkLine => {
    const code = line.slice(1)
    switch (line.charAt(0)) {
      case LINE_MARKERS.added:
        return { kind: 'added', code, number: newNumber++ }
      case LINE_MARKERS.removed:
        return { kind: 'removed', code, number: oldNumber++ }
      case LINE_MARKERS.note:
        return { kind: 'note', code, number: null }
      default:
        oldNumber++
        return { kind: 'context', code, number: newNumber++ }
    }
  })
}

/** Takes the notes out of a hunk, remembering which line of code each one follows. The header stays as it is. */
export function separateNotes(hunk: StructuredPatchHunk): { hunk: StructuredPatchHunk; notes: HunkNote[] } {
  const code: string[] = []
  const notes: HunkNote[] = []
  for (const line of hunk.lines) {
    if (line.startsWith(LINE_MARKERS.note)) notes.push({ code: line.slice(1), after: code.length - 1 })
    else code.push(line)
  }
  return { hunk: notes.length === 0 ? hunk : { ...hunk, lines: code }, notes }
}
