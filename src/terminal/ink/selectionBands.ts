/**
 * Column bands that a text selection may not cross.
 *
 * With a single full-width layout there are none, and a multi-row selection
 * spans every column of the rows between its endpoints — which is what a
 * terminal selection should do. Once the screen is split into side-by-side
 * regions (the `/diff` side panel), that is wrong in both directions: the
 * highlight bleeds across the divider into the chat, and copying picks up
 * whatever text happens to sit beside the lines you dragged over.
 *
 * So the layout publishes its regions here, and the band containing the
 * mouse-down column is pinned onto the selection at start. Everything that
 * reads the selection — the overlay, the copied text, the drag-to-scroll
 * capture — clamps to it.
 *
 * A module singleton for the same reason `instances` is one: the mouse
 * handlers live in Ink's App/instance, far below any React provider the
 * layout could reach them through.
 */

export type ColumnBand = {
  lo: number
  hi: number
  /**
   * Last row the band covers. The split does not reach the bottom of the
   * screen — the prompt spans the full width below it — so a press in those
   * rows must belong to no band rather than being clamped to one side.
   */
  rowHi?: number
}

let bands: readonly ColumnBand[] | null = null

/** Called by the layout. `null` (the default) means one full-width region. */
export function setSelectionColumnBands(next: readonly ColumnBand[] | null): void {
  bands = next && next.length > 0 ? next : null
}

/**
 * The band containing `col`, or null when the screen is not split (or the
 * point falls in no band — the divider itself, the padding around the dialog,
 * or the full-width prompt below the split. An unconstrained selection is the
 * safer fallback there.
 */
export function bandForColumn(col: number, row?: number): ColumnBand | null {
  if (!bands) return null
  for (const band of bands) {
    if (band.rowHi !== undefined && row !== undefined && row > band.rowHi) {
      continue
    }
    if (col >= band.lo && col <= band.hi) return band
  }
  return null
}
