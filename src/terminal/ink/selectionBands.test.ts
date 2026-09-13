import { afterEach, describe, expect, test } from 'bun:test'
import {
  bandForColumn,
  setSelectionColumnBands,
} from 'src/terminal/ink/selectionBands.js'
import {
  createSelectionState,
  rowColBounds,
  selectLineAt,
  startSelection,
  type SelectionState,
} from 'src/terminal/ink/selection.js'
import { selectionBands } from 'src/terminal/sidePanelLayout.js'

const WIDTH = 200
// The split stops above the full-width prompt; rows past this belong to no band.
const SPLIT_LAST_ROW = 39
// What ModalSlot publishes for a 200-column split: chat 0-99, and the panel's
// CONTENT rectangle 103-197 (divider + two paddings inset on the left, the two
// paddings on the right). Verified against a live capture: the Diff box's ╭
// sits at column 103 and its ╮ at 197.
const BANDS = selectionBands(WIDTH, SPLIT_LAST_ROW)

// Module singleton — leaving bands set would follow the process into every
// later test file.
afterEach(() => setSelectionColumnBands(null))

function selection(anchorCol: number): SelectionState {
  const s = createSelectionState()
  startSelection(s, anchorCol, 5)
  s.colBand = bandForColumn(anchorCol, 5)
  return s
}

describe('bandForColumn', () => {
  test('null when the screen is not split', () => {
    expect(bandForColumn(150)).toBeNull()
  })

  test('the panel band is the dialog content box, not the whole pane', () => {
    // Overhanging the box on both sides is what this is here to prevent.
    expect(BANDS).toEqual([
      { lo: 0, hi: 99, rowHi: SPLIT_LAST_ROW },
      { lo: 103, hi: 197, rowHi: SPLIT_LAST_ROW },
    ])
  })

  test('resolves the band a column falls in', () => {
    setSelectionColumnBands(BANDS)
    expect(bandForColumn(0, 5)?.hi).toBe(99)
    expect(bandForColumn(99, 5)?.hi).toBe(99)
    expect(bandForColumn(103, 5)?.lo).toBe(103)
    // The divider and the padding around the dialog belong to no band, so a
    // press there is left unconstrained rather than snapped to a side.
    expect(bandForColumn(100, 5)).toBeNull()
    expect(bandForColumn(198, 5)).toBeNull()
  })

  test('below the split the prompt is full width, so no band applies', () => {
    setSelectionColumnBands(BANDS)
    expect(bandForColumn(150, SPLIT_LAST_ROW)?.lo).toBe(103)
    expect(bandForColumn(150, SPLIT_LAST_ROW + 1)).toBeNull()
    expect(bandForColumn(10, SPLIT_LAST_ROW + 1)).toBeNull()
  })

  test('null for a column in no band, and an empty list resets', () => {
    setSelectionColumnBands([{ lo: 10, hi: 20 }])
    expect(bandForColumn(21)).toBeNull()
    setSelectionColumnBands([])
    expect(bandForColumn(15)).toBeNull()
  })
})

describe('rowColBounds', () => {
  const start = { col: 120, row: 5 }
  const end = { col: 140, row: 8 }

  test('an unbanded selection spans the full width on middle rows', () => {
    const s = selection(120)
    expect(rowColBounds(s, start, end, 6, WIDTH)).toEqual({
      colStart: 0,
      colEnd: WIDTH - 1,
    })
  })

  test('a banded selection never crosses into the other region', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    // The middle row is the one that used to bleed: it takes 0..width-1.
    expect(rowColBounds(s, start, end, 6, WIDTH)).toEqual({
      colStart: 103,
      colEnd: 197,
    })
  })

  test('the endpoint rows keep their own columns inside the band', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    expect(rowColBounds(s, start, end, 5, WIDTH)).toEqual({
      colStart: 120,
      colEnd: 197,
    })
    expect(rowColBounds(s, start, end, 8, WIDTH)).toEqual({
      colStart: 103,
      colEnd: 140,
    })
  })

  test('a drag started in the chat is clamped to the chat', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(10)
    expect(
      rowColBounds(s, { col: 10, row: 5 }, { col: 40, row: 8 }, 6, WIDTH),
    ).toEqual({ colStart: 0, colEnd: 99 })
  })

  test('dragging back out of the band still starts at the band edge', () => {
    // Anchor in the panel, drag up-left into the chat: the normalized `start`
    // is then the chat-side point, whose column sits outside the pinned band.
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    expect(
      rowColBounds(s, { col: 10, row: 5 }, { col: 120, row: 8 }, 5, WIDTH),
    ).toEqual({ colStart: 103, colEnd: 197 })
  })

  test('the band is clamped to the screen when the terminal shrank', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    expect(rowColBounds(s, start, end, 6, 150).colEnd).toBe(149)
  })
})

describe('selectLineAt', () => {
  const screen = { width: WIDTH, height: 40 } as never

  test('a triple-click selects the whole terminal row when unsplit', () => {
    const s = selection(120)
    selectLineAt(s, screen, 5)
    expect(s.anchor).toEqual({ col: 0, row: 5 })
    expect(s.focus).toEqual({ col: WIDTH - 1, row: 5 })
  })

  test('a triple-click in the panel selects the panel row only', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    selectLineAt(s, screen, 5)
    expect(s.anchor).toEqual({ col: 103, row: 5 })
    expect(s.focus).toEqual({ col: 197, row: 5 })
  })
})

describe('startSelection', () => {
  test('clears a stale band so a new drag is not constrained by the old one', () => {
    setSelectionColumnBands(BANDS)
    const s = selection(120)
    expect(s.colBand).toEqual({ lo: 103, hi: 197, rowHi: SPLIT_LAST_ROW })
    setSelectionColumnBands(null)
    startSelection(s, 120, 5)
    expect(s.colBand).toBeNull()
  })
})
