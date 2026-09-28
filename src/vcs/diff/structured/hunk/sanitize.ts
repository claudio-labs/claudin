/**
 * Makes hunk lines safe to draw. A line comes from a file on disk or from an
 * edit the model proposes, and the diff is what a user reads before approving
 * a write. So the code must neither act on the terminal nor restyle, hide or
 * link itself: escape sequences go together with their payloads, and so does
 * every control character but the tab. Tabs are expanded instead, so a row is
 * measured the way it will be drawn.
 */
import type { StructuredPatchHunk } from 'diff'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { LINE_MARKERS } from 'src/vcs/diff/structured/hunk/lines.js'

// Tried in order at each position: a string sequence (OSC, DCS, SOS, PM, APC)
// up to its terminator, in its 7-bit or 8-bit form; a control sequence (CSI),
// either form; any other escape; and a control character left on its own (C0
// but the tab, DEL, C1). An unterminated string loses only its introducer, and
// the rest of it shows as text.
const TERMINAL_CONTROL =
  /(?:\u001B[\]PX^_]|[\u0090\u0098\u009D-\u009F])[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[0-~]|[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g

/** Four-column stops, the ones the explorer's editor draws tabs with. */
const TAB_STOP = 4

const MARKERS: ReadonlySet<string> = new Set(Object.values(LINE_MARKERS))

// Hunks are immutable, so a clean copy is made once per hunk object.
const cleanHunks = new WeakMap<StructuredPatchHunk, StructuredPatchHunk>()

/** The code of one line (the hunk line without its marker), safe to draw. */
export function sanitizeCode(code: string): string {
  return expandTabs(code.replace(TERMINAL_CONTROL, ''))
}

/** The hunk with every line made safe. Its header is kept, and a line with an unknown marker becomes context. */
export function sanitizeHunk(hunk: StructuredPatchHunk): StructuredPatchHunk {
  const known = cleanHunks.get(hunk)
  if (known) return known
  const clean: StructuredPatchHunk = {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map(sanitizeLine),
  }
  cleanHunks.set(hunk, clean)
  cleanHunks.set(clean, clean)
  return clean
}

function sanitizeLine(line: string): string {
  const marker = line.charAt(0)
  return (MARKERS.has(marker) ? marker : LINE_MARKERS.context) + sanitizeCode(line.slice(1))
}

// Columns count from the start of the code, not from the terminal's edge, so
// a line lines up the same whatever gutter is drawn before it.
function expandTabs(code: string): string {
  if (!code.includes('\t')) return code
  const pieces = code.split('\t')
  let expanded = pieces[0]!
  let column = stringWidth(expanded)
  for (const piece of pieces.slice(1)) {
    const gap = TAB_STOP - (column % TAB_STOP)
    expanded += ' '.repeat(gap) + piece
    column += gap + stringWidth(piece)
  }
  return expanded
}
