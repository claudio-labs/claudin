import noop from 'lodash-es/noop.js'
import type { ReactElement } from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import { logForDebugging } from 'src/utils/debug.js'
import { createNode, type DOMElement } from 'src/ink/dom.js'
import { FocusManager } from 'src/ink/focus.js'
import Output from 'src/ink/output.js'
import reconciler from 'src/ink/reconciler.js'
import renderNodeToOutput, {
  resetLayoutShifted,
} from 'src/ink/render-node-to-output.js'
import {
  CellWidth,
  CharPool,
  cellAtIndex,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
  setCellStyleId,
} from 'src/ink/screen.js'

/** Position of a match within a rendered message, relative to the message's
 *  own bounding box (row 0 = message top). Stable across scroll — to
 *  highlight on the real screen, add the message's screen-row offset. */
export type MatchPosition = {
  row: number
  col: number
  /** Number of CELLS the match spans (= query.length for ASCII, more
   *  for wide chars in the query). */
  len: number
}

// Shared across calls. Pools accumulate style/char interns — reusing them
// means later calls hit cache more. Root/container reuse saves the
// createContainer cost (~1ms). LegacyRoot: all work sync, no scheduling —
// ConcurrentRoot's scheduler backlog leaks across roots via flushSyncWork.
let root: DOMElement | undefined
let container: ReturnType<typeof reconciler.createContainer> | undefined
let stylePool: StylePool | undefined
let charPool: CharPool | undefined
let hyperlinkPool: HyperlinkPool | undefined
let output: Output | undefined

const timing = { reconcile: 0, yoga: 0, paint: 0, scan: 0, calls: 0 }
const LOG_EVERY = 20


/** Scan a Screen buffer for all occurrences of query. Returns positions
 *  relative to the buffer (row 0 = buffer top). Same cell-skip logic as
 *  applySearchHighlight (SpacerTail/SpacerHead/noSelect) so positions
 *  match what the overlay highlight would find. Case-insensitive.
 *
 *  For the side-render use: this Screen is the FULL message (natural
 *  height, not viewport-clipped). Positions are stable — to highlight
 *  on the real screen, add the message's screen offset (lo). */
export function scanPositions(screen: Screen, query: string): MatchPosition[] {
  const lq = query.toLowerCase()
  if (!lq) return []
  const qlen = lq.length
  const w = screen.width
  const h = screen.height
  const noSelect = screen.noSelect
  const positions: MatchPosition[] = []

  const t0 = performance.now()
  for (let row = 0; row < h; row++) {
    const rowOff = row * w
    // Same text-build as applySearchHighlight. Keep in sync — or extract
    // to a shared helper (TODO once both are stable). codeUnitToCell
    // maps indexOf positions (code units in the LOWERCASED text) to cell
    // indices in colOf — surrogate pairs (emoji) and multi-unit lowercase
    // (Turkish İ → i + U+0307) make text.length > colOf.length.
    let text = ''
    const colOf: number[] = []
    const codeUnitToCell: number[] = []
    for (let col = 0; col < w; col++) {
      const idx = rowOff + col
      const cell = cellAtIndex(screen, idx)
      if (
        cell.width === CellWidth.SpacerTail ||
        cell.width === CellWidth.SpacerHead ||
        noSelect[idx] === 1
      ) {
        continue
      }
      const lc = cell.char.toLowerCase()
      const cellIdx = colOf.length
      for (let i = 0; i < lc.length; i++) {
        codeUnitToCell.push(cellIdx)
      }
      text += lc
      colOf.push(col)
    }
    // Non-overlapping — same advance as applySearchHighlight.
    let pos = text.indexOf(lq)
    while (pos >= 0) {
      const startCi = codeUnitToCell[pos]!
      const endCi = codeUnitToCell[pos + qlen - 1]!
      const col = colOf[startCi]!
      const endCol = colOf[endCi]! + 1
      positions.push({ row, col, len: endCol - col })
      pos = text.indexOf(lq, pos + qlen)
    }
  }
  timing.scan += performance.now() - t0

  return positions
}

/** Write CURRENT (yellow+bold+underline) at positions[currentIdx] +
 *  rowOffset. OTHER positions are NOT styled here — the scan-highlight
 *  (applySearchHighlight with null hint) does inverse for all visible
 *  matches, including these. Two-layer: scan = 'you could go here',
 *  position = 'you ARE here'. Writing inverse again here would be a
 *  no-op (withInverse idempotent) but wasted work.
 *
 *  Positions are message-relative (row 0 = message top). rowOffset =
 *  message's current screen-top (lo). Clips outside [0, height). */
export function applyPositionedHighlight(
  screen: Screen,
  stylePool: StylePool,
  positions: MatchPosition[],
  rowOffset: number,
  currentIdx: number,
): boolean {
  if (currentIdx < 0 || currentIdx >= positions.length) return false
  const p = positions[currentIdx]!
  const row = p.row + rowOffset
  if (row < 0 || row >= screen.height) return false
  const transform = (id: number) => stylePool.withCurrentMatch(id)
  const rowOff = row * screen.width
  for (let col = p.col; col < p.col + p.len; col++) {
    if (col < 0 || col >= screen.width) continue
    const cell = cellAtIndex(screen, rowOff + col)
    setCellStyleId(screen, col, row, transform(cell.styleId))
  }
  return true
}
