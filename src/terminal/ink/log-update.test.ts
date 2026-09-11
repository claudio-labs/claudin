import { expect, test } from 'bun:test'

import { emptyFrame, type Frame } from 'src/terminal/ink/frame.ts'
import {
  _resetLegacyFullResetCacheForTesting,
  LogUpdate,
} from 'src/terminal/ink/log-update.ts'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from 'src/terminal/ink/screen.ts'
import { stringWidth } from 'src/terminal/ink/stringWidth.ts'
import { cursorMove, cursorTo, eraseLines } from 'src/terminal/ink/termio/csi.ts'

function collectStdout(diff: ReturnType<LogUpdate['render']>): string {
  return diff
    .filter((patch): patch is Extract<(typeof diff)[number], { type: 'stdout' }> => patch.type === 'stdout')
    .map(patch => patch.content)
    .join('')
}

function createHarness() {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()

  return {
    stylePool,
    charPool,
    hyperlinkPool,
    log: new LogUpdate({ isTTY: true, stylePool }),
  }
}

function frameFromLines(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  lines: string[],
  cursor = { x: 0, y: lines.length, visible: true },
): Frame {
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0)
  const screen = createScreen(width, lines.length, stylePool, charPool, hyperlinkPool)

  for (const [y, line] of lines.entries()) {
    for (const [x, char] of [...line].entries()) {
      setCellAt(screen, x, y, {
        char,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }

  return {
    screen,
    viewport: {
      width: Math.max(width, 1),
      height: 10,
    },
    cursor,
  }
}

test('ghostty main-screen rewrite paints prompt content without full terminal reset when width is stable', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(stylePool, charPool, hyperlinkPool, ['      '])
  const next = frameFromLines(stylePool, charPool, hyperlinkPool, ['prompt'])

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
  expect(diff.some(patch => patch.type === 'clear' && patch.count === 1)).toBe(
    true,
  )
  expect(stdout).toContain('prompt')
})

test('ghostty main-screen rewrite clears only the changed prompt tail before repainting', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['status', '> abc'],
  )
  const next = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['status', '> abcd'],
  )

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clearTerminal')).toBe(false)
  expect(diff.some(patch => patch.type === 'clear' && patch.count === 1)).toBe(
    true,
  )
  expect(stdout).toContain('abcd')
})

test('ghostty main-screen rewrite falls back to incremental diff for larger changes', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0', 'row 1', 'row 2', 'row 3', 'row 4', '> abc'],
  )
  const next = frameFromLines(
    stylePool,
    charPool,
    hyperlinkPool,
    ['row 0 updated', 'row 1', 'row 2', 'row 3', 'row 4', '> abcd'],
  )

  const diff = log.render(prev, next, false, true, true)
  const stdout = collectStdout(diff)

  expect(diff.some(patch => patch.type === 'clear')).toBe(false)
  expect(stdout).toContain('updated')
  expect(stdout).toContain('abcd')
})

// Regression: AskUserQuestion nav-bar ghost ("S …→" orphan). The fullscreen
// REPL is a fixed-height screen; the nav bar shifts rows as you navigate
// questions, so a row holding the bar gets vacated. The bar uses ambiguous
// -width glyphs (←/→/☒/☐) that Claudin measures as width 1 but some terminals
// (Ghostty + Nerd Font) render width 2. A per-cell space clear lands at the
// MODEL columns and misses the cells the terminal drifted right, orphaning the
// tail. render() must emit an end-of-line erase for the vacated row so the
// clear is robust to that drift.
//
// This builds the frames with Claudin's width model, then replays the emitted
// diff through a tiny VT that renders the ambiguous glyphs WIDE — reproducing
// the divergence — and asserts the vacated row ends up empty.
const NAV_BAR = '\u2190  \u2612 Linguagens  \u2612 Editor  \u2610 Tema  \u2714 Submit  \u2192'
const AMBIG_WIDE = new Set([
  '\u2190',
  '\u2192',
  '\u2191',
  '\u2193',
  '\u2610',
  '\u2611',
  '\u2612',
])
const termWidth = (ch: string) =>
  AMBIG_WIDE.has(ch) ? 2 : Math.max(1, stringWidth(ch))

function fixedWidthFrame(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  lines: string[],
  width: number,
  viewportHeight: number,
): Frame {
  const screen = createScreen(
    width,
    lines.length,
    stylePool,
    charPool,
    hyperlinkPool,
  )
  for (const [y, line] of lines.entries()) {
    let x = 0
    for (const char of [...line]) {
      const w = stringWidth(char)
      if (x < width)
        setCellAt(screen, x, y, {
          char,
          styleId: stylePool.none,
          width: w === 2 ? CellWidth.Wide : CellWidth.Narrow,
          hyperlink: undefined,
        })
      x += Math.max(1, w)
    }
  }
  screen.damage = undefined
  return { screen, viewport: { width, height: viewportHeight }, cursor: { x: 0, y: 0, visible: true } }
}

// Render the lines into a grid using TERMINAL (ambiguous-wide) widths.
function gridFromLines(lines: string[], width: number): string[][] {
  return lines.map(line => {
    const row = Array<string>(width).fill(' ')
    let x = 0
    for (const ch of [...line]) {
      if (x < width) row[x] = ch
      const w = termWidth(ch)
      if (w === 2 && x + 1 < width) row[x + 1] = ''
      x += w
    }
    return row
  })
}

// Apply the diff (serialized like terminal.ts) onto a grid, advancing the
// cursor by TERMINAL widths so the model/terminal drift is exercised.
function replayDiff(grid: string[][], diff: ReturnType<LogUpdate['render']>) {
  let ansi = ''
  for (const p of diff) {
    if (p.type === 'stdout') ansi += p.content
    else if (p.type === 'clear') ansi += p.count > 0 ? eraseLines(p.count) : ''
    else if (p.type === 'cursorMove') ansi += cursorMove(p.x, p.y)
    else if (p.type === 'cursorTo') ansi += cursorTo(p.col)
    else if (p.type === 'carriageReturn') ansi += '\r'
  }
  const width = grid[0].length
  let row = 0
  let col = 0
  let i = 0
  while (i < ansi.length) {
    const c = ansi[i]
    if (c === '\x1b' && ansi[i + 1] === '[') {
      let j = i + 2
      let num = ''
      while (j < ansi.length && /[0-9;]/.test(ansi[j])) num += ansi[j++]
      const cmd = ansi[j]
      const n = parseInt(num || '1', 10)
      if (cmd === 'A') row = Math.max(0, row - n)
      else if (cmd === 'B') row += n
      else if (cmd === 'C') col += n
      else if (cmd === 'D') col = Math.max(0, col - n)
      else if (cmd === 'G') col = parseInt(num || '1', 10) - 1
      else if (cmd === 'K') {
        const m = parseInt(num || '0', 10)
        if (m === 2) for (let x = 0; x < width; x++) grid[row][x] = ' '
        else if (m === 0) for (let x = col; x < width; x++) grid[row][x] = ' '
        else for (let x = 0; x <= col; x++) grid[row][x] = ' '
      }
      i = j + 1
      continue
    }
    if (c === '\r') {
      col = 0
      i++
      continue
    }
    if (c === '\n') {
      row++
      i++
      continue
    }
    if (c === '\x1b') {
      // skip other ESC sequences conservatively (OSC ends at BEL)
      i++
      if (ansi[i] === ']') {
        while (i < ansi.length && ansi[i] !== '\x07') i++
      }
      i++
      continue
    }
    const cp = ansi.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    if (col < width) grid[row][col] = ch
    const w = termWidth(ch)
    if (w === 2 && col + 1 < width) grid[row][col + 1] = ''
    col += w
    i += ch.length
  }
  return grid
}

test('vacated nav-bar row is cleared even when the terminal renders ambiguous glyphs wide', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const W = 120
  const VP = 46
  const blank = () => Array.from({ length: 40 }, () => '')

  // PREV: nav bar at row 28 (a question view). NEXT: nav bar shifted to row 27
  // (the submit review view), so row 28 is vacated.
  const prevLines = blank()
  prevLines[27] = '\u2500'.repeat(W)
  prevLines[28] = NAV_BAR
  prevLines[30] = 'Qual seu tema favorito?'
  prevLines[32] = '\u276f 1. Escuro'

  const nextLines = blank()
  nextLines[25] = '\u2500'.repeat(W)
  nextLines[27] = NAV_BAR
  nextLines[29] = 'Review your answers'
  nextLines[31] = ' \u25cf Quais linguagens?'

  const prev = fixedWidthFrame(stylePool, charPool, hyperlinkPool, prevLines, W, VP)
  const next = fixedWidthFrame(stylePool, charPool, hyperlinkPool, nextLines, W, VP)
  const diff = log.render(prev, next, false, true, false)

  // Sanity: no full reset (this must be handled incrementally).
  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)

  const grid = gridFromLines(prevLines, W)
  replayDiff(grid, diff)

  const vacated = grid[28].join('').replace(/[\s\u0000]+/g, '')
  expect(vacated).toBe('')
})

// Regression: the startup banner (and the transcript head under it) reappeared
// over and over in the scrollback of a long non-fullscreen session. Every full
// reset repainted the frame from row 0, and renderFrameSlice advances with real
// LFs — so each row above the viewport was pushed back into scrollback as a
// second copy. clearTerminal only erases the viewport (no CSI 3J), so the old
// copy stays too. A reset must repaint the visible tail and nothing else.
function scrollbackFrame(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  lines: string[],
  viewportHeight: number,
): Frame {
  const frame = frameFromLines(stylePool, charPool, hyperlinkPool, lines)
  return { ...frame, viewport: { ...frame.viewport, height: viewportHeight } }
}

// 20 equal-width rows so a width change can't turn this into a resize reset.
const TALL_LINES = Array.from({ length: 20 }, (_, i) => `ROW${String(i).padStart(2, '0')}xxxxx`)
const TALL_VIEWPORT = 10

function countNewlines(stdout: string): number {
  return stdout.split('\n').length - 1
}

// Net vertical movement of a diff, in rows: eraseLines(n) ends n-1 rows above
// where it started, a cursorMove carries its own dy, and every LF is one row
// down (at the bottom of the terminal an LF scrolls instead, which moves the
// block up by the same amount — either way the block ends where this says).
// Only meaningful for a diff with no clearTerminal, which positions absolutely.
function netRowDelta(diff: ReturnType<LogUpdate['render']>): number {
  let dy = 0
  for (const p of diff) {
    if (p.type === 'clear') dy -= Math.max(0, p.count - 1)
    else if (p.type === 'cursorMove') dy += p.y
    else if (p.type === 'stdout') dy += (p.content.match(/\n/g) ?? []).length
  }
  return dy
}

// A row that already scrolled off is unreachable, and since the reset above
// repaints only the tail it could not have shown the change either — it only
// blanked and repainted the viewport. So a change up there is not a reset
// trigger at all: a blinking in-progress dot in a collapsed group 80 rows up
// used to clear the screen on every blink (11 resets in 15 minutes, all
// `offscreen · row 61`, in one measured session).
test('a change to a scrolled-off row is ignored instead of resetting the screen', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const nextLines = [...TALL_LINES]
  // Row 0 is deep in scrollback (viewportY is 11).
  nextLines[0] = 'ROW00yyyyy'

  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, nextLines, TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  expect(stdout).not.toContain('ROW00')
  expect(countNewlines(stdout)).toBe(0)
})

// The same frame with a change inside the viewport still goes through the
// incremental diff — the scrolled-off change above it is simply not part of
// the output.
test('a scrolled-off change does not stop visible rows from being diffed in place', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const nextLines = [...TALL_LINES]
  nextLines[0] = 'ROW00yyyyy'
  nextLines[15] = 'ROW15zzzzz'

  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, nextLines, TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  expect(stdout).toContain('zzzzz')
  expect(stdout).not.toContain('yyyyy')
  // Only the cursor restore's LFs (row 15 back down to the cursor row 20),
  // all inside the viewport — nothing scrolls.
  expect(countNewlines(stdout)).toBe(5)
})

// A reset of a frame that FITS the viewport still repaints every row — but it
// bottom-anchors them. Top-anchoring put the block at viewport row 0, which
// pulled the input box off the bottom of the terminal and, when startY reached
// 0 or 1, repainted the startup banner (frame row 0) mid-session. The padding
// LFs walk down to the anchor first; the rows themselves are unchanged.
test('a full reset of a frame that fits the viewport repaints every row, anchored at the bottom', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const lines = TALL_LINES.slice(0, 6)

  // Viewport shrank 12 -> 10: log-update resets immediately (resize branch).
  // The frame is 6 rows, so nothing is in scrollback and nothing may be sliced.
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, lines, 12)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, lines, 10)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
  expect(stdout).toContain('ROW00xxxxx')
  expect(stdout).toContain('ROW05xxxxx')
  // usableRows 9 - 6 painted = 3 padding rows, emitted BEFORE the first row.
  expect(stdout.startsWith('\n\n\n')).toBe(true)
  expect(stdout.indexOf('ROW00xxxxx')).toBeGreaterThan(2)
  expect(countNewlines(stdout)).toBe(3 + 6)
})

// Shrinking while the frame overflows must not clear just the VACATED rows:
// eraseLines cannot scroll, so the cursor would sit linesToClear rows above
// the bottom while the next frame derives viewportY as if it were AT the
// bottom — its cursor-up then clamps at row 0 and every later write lands rows
// off (measured: a 13-row shrink followed by a frame whose UP 38 ran from row
// 26, which wove "…echotdone"ncompletedl(exitpcodeb0)eath the input box" out
// of two rows).
//
// repaintTailInPlace erases exactly as many rows as it repaints, so the cursor
// ends where it started and the premise holds — without blanking the screen.
// Measured 2026-09-09: this branch fired 35 times over 36 messages, so the
// clearTerminal it used to emit was a full-screen repaint per turn.
test('shrinking while overflowing repaints the tail in place, without clearing the screen', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  // 20 -> 17 rows, viewport 10: still overflowing after the shrink.
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 17), TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  // Erases the 9 reachable rows and repaints the same 9 — net zero movement.
  expect(
    diff.some(
      p => p.type === 'clear' && p.count === 9 && p.repaintReason === 'offscreen',
    ),
  ).toBe(true)
  // One step up onto the last row eraseLines will clear.
  expect(diff.some(p => p.type === 'cursorMove' && p.y === -1)).toBe(true)
  // Tail of the NEW frame: rows 8..16, cursor parked on the last viewport row.
  expect(stdout).toContain('ROW08xxxxx')
  expect(stdout).toContain('ROW16xxxxx')
  expect(stdout).not.toContain('ROW07xxxxx')
  expect(stdout).not.toContain('ROW17')
  expect(countNewlines(stdout)).toBe(9)
})

// The Ghostty main-screen rewrite computes its startY from firstChangedY,
// which a shrink makes meaningless, so it must still defer to this branch.
test('main-screen rewrite defers to the in-place tail repaint when shrinking while overflowing', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 18), TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, true)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  expect(
    diff.some(
      p => p.type === 'clear' && p.count === 9 && p.repaintReason === 'offscreen',
    ),
  ).toBe(true)
})

// The reported bug: a frame that shrinks BELOW the viewport used to be
// repainted from viewport row 0, which put frame row 0 — the startup banner —
// at the top of the screen and pulled the input box up with it. Captured live
// as `screenH=15 viewportH=18 startY=0`. Bottom-anchoring keeps the block on
// the last rows; the rows above keep whatever history was there.
test('a frame that shrinks below the viewport stays anchored at the bottom', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 6), TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  // 6 rows erased and 6 repainted — NOT the 9 a viewport-filling repaint would
  // touch, and no padding: the block already ends on the cursor row.
  expect(
    diff.some(
      p => p.type === 'clear' && p.count === 6 && p.repaintReason === 'offscreen',
    ),
  ).toBe(true)
  expect(diff.some(p => p.type === 'cursorMove' && p.y === -1)).toBe(true)
  expect(stdout).toContain('ROW00xxxxx')
  expect(stdout).toContain('ROW05xxxxx')
  expect(countNewlines(stdout)).toBe(6)
})

// The killswitch has to revert BOTH halves: the path choice and the padding.
// A short frame is the only shape where the two are visible at once.
test('CLAUDIN_LEGACY_FULL_RESET restores the clearing, top-anchored reset', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const saved = process.env.CLAUDIN_LEGACY_FULL_RESET
  process.env.CLAUDIN_LEGACY_FULL_RESET = '1'
  _resetLegacyFullResetCacheForTesting()
  try {
    const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)
    const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 6), TALL_VIEWPORT)
    const diff = log.render(prev, next, false, true, false)
    const stdout = collectStdout(diff)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
    expect(diff.some(p => p.type === 'clear')).toBe(false)
    // Top-anchored: the frame starts at viewport row 0, no padding LFs.
    expect(stdout.startsWith('\n')).toBe(false)
    expect(countNewlines(stdout)).toBe(6)
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDIN_LEGACY_FULL_RESET
    } else {
      process.env.CLAUDIN_LEGACY_FULL_RESET = saved
    }
    _resetLegacyFullResetCacheForTesting()
  }
})

// A frame that fits the viewport takes the SAME in-place repaint. It used to
// fall through to the incremental path, which clears only the vacated rows and
// leaves the cursor that many rows higher — see the regression below.
test('shrinking a frame that fits the viewport repaints the tail in place', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 8), TALL_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES.slice(0, 5), TALL_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  // 5 erased and 5 repainted, not the 3 vacated rows — net zero movement.
  expect(
    diff.some(
      p => p.type === 'clear' && p.count === 5 && p.repaintReason === 'offscreen',
    ),
  ).toBe(true)
  expect(netRowDelta(diff)).toBe(0)
})

// 45 rows in a 46-row viewport: one row short of prevHadScrollback, which is
// the shape a long session lands in once a compaction drops the frame under
// the viewport. The next big shrink — a tool block collapsing to
// "… +16 lines (ctrl+o to see all)" — used to strand the block: the
// incremental path erased the 30 vacated rows and left the cursor 30 rows
// higher, so the block kept its top row and the rows it gave up stayed blank
// BELOW it. Nothing re-anchored afterwards (every later repaint is relative),
// so the whole TUI sat in the top fifth of the terminal until a resize or
// ctrl+L. Reported as "a sessão colapsa e fica no topo".
const NEAR_VIEWPORT = 46
const NEAR_VIEWPORT_LINES = Array.from(
  { length: 45 },
  (_, i) => `ROW${String(i).padStart(2, '0')}xxxxx`,
)
test('a big shrink of a frame that FITS the viewport keeps the block where it was', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, NEAR_VIEWPORT_LINES, NEAR_VIEWPORT)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, NEAR_VIEWPORT_LINES.slice(0, 15), NEAR_VIEWPORT)
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  // The block's last row lands on the row the old block's last row held.
  expect(netRowDelta(diff)).toBe(0)
  expect(
    diff.some(
      p => p.type === 'clear' && p.count === 15 && p.repaintReason === 'offscreen',
    ),
  ).toBe(true)
  expect(stdout).toContain('ROW00xxxxx')
  expect(stdout).toContain('ROW14xxxxx')
  expect(stdout).not.toContain('ROW15xxxxx')
})

// What the killswitch has to restore, and the measurement the fix is against:
// the same shrink on the old path ends 30 rows above where it started.
test('CLAUDIN_LEGACY_FULL_RESET puts the fits-the-viewport shrink back on the incremental path', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const saved = process.env.CLAUDIN_LEGACY_FULL_RESET
  process.env.CLAUDIN_LEGACY_FULL_RESET = '1'
  _resetLegacyFullResetCacheForTesting()
  try {
    const prev = scrollbackFrame(stylePool, charPool, hyperlinkPool, NEAR_VIEWPORT_LINES, NEAR_VIEWPORT)
    const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, NEAR_VIEWPORT_LINES.slice(0, 15), NEAR_VIEWPORT)
    const diff = log.render(prev, next, false, true, false)

    expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
    // Only the 30 vacated rows are cleared, and the cursor stays up there.
    expect(diff.some(p => p.type === 'clear' && p.count === 30)).toBe(true)
    expect(netRowDelta(diff)).toBe(-30)
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDIN_LEGACY_FULL_RESET
    } else {
      process.env.CLAUDIN_LEGACY_FULL_RESET = saved
    }
    _resetLegacyFullResetCacheForTesting()
  }
})

// Second half of the same bug: Ink.repaint() (ctrl+L, prepareFullRepaint,
// exiting alt-screen) zeroes the frames, and a prev height of 0 sends render()
// down the `growing` path — which emitted the whole frame with real LFs and
// scrolled another copy of everything into scrollback. ctrl+L added one banner
// per press.
test('a repaint repaints the viewport instead of re-emitting the whole frame', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = emptyFrame(TALL_VIEWPORT, 10, stylePool, charPool, hyperlinkPool)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)

  log.markPendingRepaint()
  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(true)
  expect(stdout).not.toContain('ROW00')
  expect(stdout).toContain('ROW11xxxxx')
  expect(stdout).toContain('ROW19xxxxx')
  expect(countNewlines(stdout)).toBe(9)
})

// The flag is what separates a repaint from the genuine first frame of a
// session, where prev is also 0×0 and printing the whole transcript (a long
// /resume, say) is exactly right.
test('the first frame of a session still prints the whole frame', () => {
  const { stylePool, charPool, hyperlinkPool, log } = createHarness()
  const prev = emptyFrame(TALL_VIEWPORT, 10, stylePool, charPool, hyperlinkPool)
  const next = scrollbackFrame(stylePool, charPool, hyperlinkPool, TALL_LINES, TALL_VIEWPORT)

  const diff = log.render(prev, next, false, true, false)
  const stdout = collectStdout(diff)

  expect(diff.some(p => p.type === 'clearTerminal')).toBe(false)
  expect(stdout).toContain('ROW00xxxxx')
  expect(stdout).toContain('ROW19xxxxx')
  expect(countNewlines(stdout)).toBe(20)
})
