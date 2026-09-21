import { describe, expect, test } from 'bun:test'
import {
  computeDialogBodyRows,
  computeTakeoverLayout,
  TAKEOVER_LIST_MAX_ROWS,
} from 'src/vcs/diff/ui/layout.js'

// contentHeight under the takeover is `rows - 9`, so a 46-row terminal gives 37.
const TALL = 37
// Each section spends one row: a top-border rule carrying its title.
const CHROME = 0

describe('computeTakeoverLayout', () => {
  test('a small changeset gives its rows to the list and the rest to the diff', () => {
    const { listInner, listMaxVisible, diffInner } = computeTakeoverLayout(
      TALL,
      3,
    )
    expect(listInner).toBe(3)
    // Nothing is hidden, so no row is reserved for the ↑/↓ indicators.
    expect(listMaxVisible).toBe(3)
    expect(diffInner).toBe(TALL - CHROME - 3)
  })

  test('the list caps and reserves two rows for the more-indicators', () => {
    const { listInner, listMaxVisible, diffInner } = computeTakeoverLayout(
      TALL,
      40,
    )
    expect(listInner).toBe(TAKEOVER_LIST_MAX_ROWS)
    expect(listMaxVisible).toBe(TAKEOVER_LIST_MAX_ROWS - 2)
    expect(diffInner).toBe(TALL - CHROME - TAKEOVER_LIST_MAX_ROWS)
  })

  test('the two panes never exceed the shared budget', () => {
    for (const contentHeight of [6, 10, 20, 37, 80]) {
      for (const treeRowCount of [0, 1, 5, 11, 200]) {
        const { listInner, diffInner } = computeTakeoverLayout(
          contentHeight,
          treeRowCount,
        )
        expect(listInner + diffInner).toBeLessThanOrEqual(
          Math.max(4, contentHeight - CHROME),
        )
      }
    }
  })

  test('a short terminal still leaves the diff three rows', () => {
    const { listInner, diffInner } = computeTakeoverLayout(6, 40)
    expect(diffInner).toBeGreaterThanOrEqual(3)
    expect(listInner).toBeGreaterThanOrEqual(1)
  })

  test('a short terminal splits rather than starving the diff', () => {
    // 24 terminal rows → contentHeight 15, interior 13. The flat cap alone gave
    // the list 10 and left the diff on its 3-row floor.
    const { listInner, diffInner } = computeTakeoverLayout(15, 12)
    expect(listInner).toBeLessThanOrEqual(diffInner)
    expect(diffInner).toBeGreaterThan(3)
  })

  test('an empty working tree keeps one row for its message', () => {
    expect(computeTakeoverLayout(TALL, 0).listInner).toBe(1)
  })

  test('listMaxVisible never drops below 1', () => {
    // 5 rows of interior: the list gets 2, and reserving both indicator rows
    // would leave nothing to render.
    const { listMaxVisible } = computeTakeoverLayout(7, 40)
    expect(listMaxVisible).toBeGreaterThanOrEqual(1)
  })
})

describe('computeDialogBodyRows', () => {
  // What the panel measured in the screenshot this was fixed from.
  const PANEL_ROWS = 41
  // The inline body pays for its own marginTop; a bordered pane, two edges.
  const INLINE = 1
  const PANE = 2

  test('the body plus the column chrome leaves one row at the bottom', () => {
    const body = computeDialogBodyRows(PANEL_ROWS, false, INLINE)
    // 1 tab bar + 1 gap + 1 marginTop + body + 1 gap + 1 footer.
    expect(body + 5).toBe(PANEL_ROWS - 1)
  })

  test('a bordered pane keeps the same outer height as the inline body', () => {
    const pane = computeDialogBodyRows(PANEL_ROWS, false, PANE)
    // The pane spends its extra row on borders, not on a marginTop, so the
    // footer lands on the same line either way.
    expect(pane + 2).toBe(computeDialogBodyRows(PANEL_ROWS, false, INLINE) + 1)
  })

  test('it beats the stacked budget, which is what stranded the footer', () => {
    // The inline body used to run on the stacked layout's `contentHeight`
    // (`rows - 9`), which pays for a source line and two section rules that
    // are not on screen here: three rows the column had and never used.
    expect(computeDialogBodyRows(PANEL_ROWS, false, INLINE)).toBe(
      PANEL_ROWS - 9 + 3,
    )
  })

  test('a project line above the body costs it the line and the gap', () => {
    expect(computeDialogBodyRows(PANEL_ROWS, true, INLINE)).toBe(
      computeDialogBodyRows(PANEL_ROWS, false, INLINE) - 2,
    )
  })

  test('a short panel still leaves three rows to render into', () => {
    for (const rows of [0, 1, 6, 8]) {
      expect(computeDialogBodyRows(rows, true, PANE)).toBeGreaterThanOrEqual(3)
    }
  })
})
