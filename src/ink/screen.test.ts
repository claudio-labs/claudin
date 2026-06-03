import { expect, test } from 'bun:test'

import {
  CellWidth,
  CharPool,
  createScreen,
  diffEach,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.ts'

function makeScreen(width: number, lines: string[]) {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const screen = createScreen(
    width,
    lines.length,
    stylePool,
    charPool,
    hyperlinkPool,
  )
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
  // Reset the damage accrued while populating, then mark only the cells that
  // actually changed — this mirrors the production frame where damage tracks
  // the WRITTEN region of `next`, not the cells that `prev` left behind.
  screen.damage = undefined
  return screen
}

// Regression for the stale-character bug: a row shrinks at constant terminal
// width (e.g. a task-list row whose owner/spinner suffix vanishes, or a wide
// tool-output row replaced by a shorter task row). The damage region only
// covers the left portion that changed value, so the right-hand columns the
// text vacated must still be diffed and emitted as removals to be cleared.
test('diffEach emits removals for cells vacated by a shrinking row at constant width', () => {
  const width = 20
  const prev = makeScreen(width, ['task open (@owner)x'])
  const next = makeScreen(width, ['task open'])

  // Simulate a narrow damage region that only spans the leftmost changed cell,
  // as render-node-to-output would record when content shrinks.
  next.damage = { x: 0, y: 0, width: 1, height: 1 }

  // Columns the text vacated must be VISITED by the diff (prev had a glyph,
  // next is empty) so the renderer can overwrite them with spaces. Before the
  // fix the narrow damage region clipped the scan and these were never seen.
  const clearedXs: number[] = []
  diffEach(prev, next, (x, _y, removed, added) => {
    if (removed && removed.char !== ' ' && added && added.char === ' ') {
      clearedXs.push(x)
    }
  })

  // Every column holding the vacated '(@owner)x' suffix must be visited,
  // including the trailing 'x' at the far right of the old row.
  for (let x = 'task open '.length; x < 'task open (@owner)x'.length; x++) {
    expect(clearedXs).toContain(x)
  }
})
