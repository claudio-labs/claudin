import React, { useRef } from 'react'
import type { EditorHighlighter } from 'src/native-ts/color-diff/index.js'
import { Box, RawAnsi, Text } from 'src/ink.js'
import type { Cursor } from 'src/components/explorer/editorState.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const INVERSE = '\x1b[7m'

type Props = {
  /** Per-file highlighter, or null when syntax highlight is disabled. */
  highlighter: EditorHighlighter | null
  lines: string[]
  cursor: Cursor
  /** Whether the content pane currently owns the cursor (draw block cursor). */
  focused: boolean
  /** Inner viewport height in rows. */
  height: number
  /** Inner pane width in columns. */
  width: number
  /** When set, the file isn't editable (binary / too large): show this notice. */
  readOnlyNotice?: string | null
}

/** Tab width must match EDITOR_TAB_WIDTH in native-ts/color-diff. */
const TAB_WIDTH = 4

/** Plain (no-highlight) fallback: expand tabs and clip to the window. */
function plainLineWindow(
  line: string,
  fromCol: number,
  width: number,
  cursorCol?: number,
): string {
  let expanded = ''
  let col = 0
  for (const ch of line) {
    if (ch === '\t') {
      const n = TAB_WIDTH - (col % TAB_WIDTH)
      expanded += ' '.repeat(n)
      col += n
    } else {
      expanded += ch
      col += 1
    }
  }
  let out = ''
  for (let c = fromCol; c < fromCol + width; c++) {
    const ch = expanded[c] ?? ' '
    if (cursorCol !== undefined && c === cursorCol) out += `${INVERSE}${ch}${RESET}`
    else out += ch
  }
  return out
}

/**
 * The right-hand content pane: a fixed-height, no-wrap, horizontally-scrolling
 * view of the file with a line-number gutter and a block cursor. Windowing is
 * manual (slice visible rows → RawAnsi) because ScrollBox only clips inside an
 * alt-screen fullscreen root (team memory: scrollbox-inline-no-clip).
 */
export function FilePane({
  highlighter,
  lines,
  cursor,
  focused,
  height,
  width,
  readOnlyNotice,
}: Props): React.ReactNode {
  const scrollTopRef = useRef(0)

  if (readOnlyNotice) {
    return (
      <Box flexDirection="column">
        <Text dimColor italic>
          {readOnlyNotice}
        </Text>
      </Box>
    )
  }

  const numW = Math.max(2, String(lines.length).length)
  const gutterW = numW + 2
  const contentW = Math.max(1, width - gutterW)

  // Cursor display column (tabs/wide chars expanded) drives horizontal scroll.
  const cursorLine = lines[cursor.row] ?? ''
  const displayCursorCol = highlighter
    ? highlighter.displayColOf(cursorLine, cursor.col)
    : plainDisplayCol(cursorLine, cursor.col)
  const leftCol =
    displayCursorCol < contentW ? 0 : displayCursorCol - contentW + 1

  // Vertical scroll follows the cursor with minimal movement (ref-derived).
  let scrollTop = scrollTopRef.current
  if (cursor.row < scrollTop) scrollTop = cursor.row
  else if (cursor.row >= scrollTop + height) scrollTop = cursor.row - height + 1
  scrollTop = Math.min(Math.max(0, scrollTop), Math.max(0, lines.length - height))
  scrollTopRef.current = scrollTop

  const rows: string[] = []
  for (let r = scrollTop; r < scrollTop + height; r++) {
    if (r >= lines.length) {
      rows.push(`${DIM} ${'~'.padStart(numW)} ${RESET}`)
      continue
    }
    const gutter = `${DIM} ${String(r + 1).padStart(numW)} ${RESET}`
    const isCursorRow = focused && r === cursor.row
    const cursorCol = isCursorRow ? displayCursorCol : undefined
    const content = highlighter
      ? highlighter.renderLineWindow(lines[r]!, leftCol, contentW, cursorCol)
      : plainLineWindow(lines[r]!, leftCol, contentW, cursorCol)
    rows.push(gutter + content)
  }

  return (
    <Box flexDirection="column" width="100%">
      <RawAnsi lines={rows} width={width} />
    </Box>
  )
}

/** Plain display-column mapping (tabs only) for the no-highlighter path. */
function plainDisplayCol(line: string, logicalCol: number): number {
  let col = 0
  const end = Math.min(logicalCol, line.length)
  for (let i = 0; i < end; i++) {
    if (line[i] === '\t') col += TAB_WIDTH - (col % TAB_WIDTH)
    else col += 1
  }
  return col
}
