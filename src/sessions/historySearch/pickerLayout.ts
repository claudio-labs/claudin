/**
 * How the Ctrl+R picker reads at a given terminal width: the width of a
 * row's text and of the preview, where the preview sits, a row's text, and
 * the preview's lines.
 */
import { formatRelativeTimeAgo, truncateToWidth } from 'src/shared/text/format.js'
import { wrapAnsi } from 'src/terminal/ink/wrapAnsi.js'

/** From this width up, the preview sits beside the list rather than under it. */
const SIDE_BY_SIDE_COLUMNS = 100
/** The pane's padding and the list's mark column. */
const LIST_CHROME = 6
/** Beside the list, the preview also loses the gap between them and its own border and padding. */
const PREVIEW_BESIDE_CHROME = 12
/** Under the list, the preview loses the pane's padding and its own border and padding. */
const PREVIEW_BELOW_CHROME = 10
const MIN_TEXT_WIDTH = 20
/** A row's age is padded to this many columns, and a space follows it. */
const AGE_COLUMN = 8
const MAX_PREVIEW_LINES = 6

const LINE_BREAK_RE = /\r\n|\r|\n/

type PickerWidths = {
  readonly previewBeside: boolean
  /** The width a row's first line is cut to. */
  readonly rowText: number
  /** The width the preview wraps to. */
  readonly preview: number
}

type PromptRow = {
  /** The age, padded to its column. */
  readonly age: string
  readonly text: string
}

export function pickerWidths(columns: number): PickerWidths {
  const previewBeside = columns >= SIDE_BY_SIDE_COLUMNS
  const list = previewBeside ? Math.floor((columns - LIST_CHROME) / 2) : columns - LIST_CHROME
  const preview = previewBeside ? columns - list - PREVIEW_BESIDE_CHROME : columns - PREVIEW_BELOW_CHROME
  return {
    previewBeside,
    rowText: Math.max(MIN_TEXT_WIDTH, list - AGE_COLUMN - 1),
    preview: Math.max(MIN_TEXT_WIDTH, preview),
  }
}

/** A row: how long ago the prompt was typed, and its first line cut to `width`. */
export function promptRow(prompt: { readonly display: string; readonly timestamp: number }, width: number, now?: Date): PromptRow {
  const firstLine = prompt.display.split(LINE_BREAK_RE, 1)[0] ?? ''
  return {
    age: formatRelativeTimeAgo(new Date(prompt.timestamp), { now }).padEnd(AGE_COLUMN),
    text: truncateToWidth(firstLine, width),
  }
}

/**
 * The whole prompt wrapped hard to `width`, without blank lines. Past six
 * lines, the first five are kept and the last one counts the rest.
 */
export function previewLines(display: string, width: number): string[] {
  const lines = wrapAnsi(display, width, { hard: true })
    .split('\n')
    .filter(line => line.trim() !== '')
  if (lines.length <= MAX_PREVIEW_LINES) return lines
  const kept = lines.slice(0, MAX_PREVIEW_LINES - 1)
  return [...kept, `… +${lines.length - kept.length} more lines`]
}
