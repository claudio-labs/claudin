import type { StructuredPatchHunk } from 'diff'
import stripAnsi from 'strip-ansi'
import type { ColorDiff } from 'src/native-ts/color-diff/index.js'
import sliceAnsi from 'src/shared/text/sliceAnsi.js'
import { color } from 'src/terminal/design-system/color.js'
import type { ThemeName } from 'src/terminal/theme/theme.js'
import { type HunkNote, LINE_MARKERS, separateNotes } from 'src/vcs/diff/structured/hunk/lines.js'
import { sanitizeHunk } from 'src/vcs/diff/structured/hunk/sanitize.js'
import { digitCount } from 'src/vcs/diff/structured/layout/width.js'
import { wrapSpans } from 'src/vcs/diff/structured/layout/wrap.js'

/** What to ask the syntax renderer for, and how its rows are shown. */
type HighlightRequest = {
  /** The hunk as the caller passed it. Pictures are kept per hunk object. */
  hunk: StructuredPatchHunk
  themeName: ThemeName
  /** The effective width: whole columns, at least one. */
  width: number
  dim: boolean
  filePath: string
  firstLine: string | null
  fileContent: string | null
  /** Fullscreen: the gutter is set apart, so a drag selects only code. */
  fenced: boolean
}

/** The rows to paint, in one piece or as a gutter column beside a code column. */
export type HighlightedPicture =
  | { kind: 'whole'; rows: string[] }
  | { kind: 'fenced'; gutterWidth: number; gutter: string[]; code: string[] }

/** The renderer's gutter besides the digits: a space on each side of the number, and the marker. */
const GUTTER_AROUND_DIGITS = 3
const DIGIT = /[0-9]/

// A few widths and themes of one hunk. Older pictures give way, so resizing a
// terminal with a diff on screen does not pile them up.
const PICTURES_PER_HUNK = 8

// A remount redraws every message (ctrl+o does it to the whole transcript) and
// must not run the renderer again. Held weakly, a picture never outlives its hunk.
const pictures = new WeakMap<StructuredPatchHunk, Map<string, HighlightedPicture | null>>()

/**
 * The syntax renderer's rows for a hunk, or null when it drew nothing and the
 * plain diff has to stand in. The renderer only ever sees the sanitized hunk.
 */
export function highlightedPicture(request: HighlightRequest, Renderer: typeof ColorDiff): HighlightedPicture | null {
  const key = JSON.stringify([
    request.themeName,
    request.width,
    request.dim,
    request.filePath,
    request.firstLine,
    request.fenced,
  ])
  let kept = pictures.get(request.hunk)
  if (kept === undefined) {
    kept = new Map()
    pictures.set(request.hunk, kept)
  }
  if (kept.has(key)) {
    const picture = kept.get(key) ?? null
    kept.delete(key)
    kept.set(key, picture)
    return picture
  }
  const picture = drawPicture(request, Renderer)
  kept.set(key, picture)
  if (kept.size > PICTURES_PER_HUNK) {
    const oldest = kept.keys().next()
    if (!oldest.done) kept.delete(oldest.value)
  }
  return picture
}

function drawPicture(request: HighlightRequest, Renderer: typeof ColorDiff): HighlightedPicture | null {
  const { hunk, notes } = separateNotes(sanitizeHunk(request.hunk))
  const drawn = new Renderer(hunk, request.firstLine, request.filePath, request.fileContent).render(
    request.themeName,
    request.width,
    request.dim,
  )
  if (drawn === null) return null
  const digits = gutterDigits(hunk)
  const rows = notes.length === 0 ? drawn : withNotes(drawn, notes, hunk.lines.length, digits, request)
  const gutterWidth = digits + GUTTER_AROUND_DIGITS
  if (!request.fenced || gutterWidth >= request.width) return { kind: 'whole', rows }
  return {
    kind: 'fenced',
    gutterWidth,
    gutter: rows.map(row => sliceAnsi(row, 0, gutterWidth)),
    code: rows.map(row => sliceAnsi(row, gutterWidth)),
  }
}

/** Digits in the renderer's number column: those of the hunk's last line on either side, and at least one. */
function gutterDigits(hunk: StructuredPatchHunk): number {
  return digitCount(Math.max(1, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1))
}

/**
 * Puts each note back under the rows of the line of code it qualifies. A
 * line's first row carries its number, whose last digit sits just before the
 * space and the marker; the rows that continue a line leave it blank. Should
 * the rows not map onto the lines, the notes still show, after them.
 */
function withNotes(
  rows: string[],
  notes: readonly HunkNote[],
  lineCount: number,
  digits: number,
  request: HighlightRequest,
): string[] {
  const firstRows = rows.flatMap((row, index) => (DIGIT.test(stripAnsi(row).charAt(digits)) ? [index] : []))
  if (firstRows.length !== lineCount || (rows.length > 0 && firstRows[0] !== 0)) {
    return [...rows, ...notes.flatMap(note => drawNote(note, digits, request))]
  }
  const notesAfter = (line: number): string[] =>
    notes.filter(note => note.after === line).flatMap(note => drawNote(note, digits, request))
  const placed = notesAfter(-1)
  firstRows.forEach((start, line) => {
    placed.push(...rows.slice(start, firstRows[line + 1] ?? rows.length), ...notesAfter(line))
  })
  return placed
}

// No number, the note's marker in the marker column, and the quiet colour the
// plain diff draws notes in.
function drawNote(note: HunkNote, digits: number, request: HighlightRequest): string[] {
  const gutter = ' '.repeat(digits + GUTTER_AROUND_DIGITS - 1) + LINE_MARKERS.note
  const paint = color('inactive', request.themeName)
  return wrapSpans([{ text: note.code, tag: 'note' }], Math.max(1, request.width - gutter.length)).map(row =>
    paint(gutter + row.spans.map(span => span.text).join('')),
  )
}
