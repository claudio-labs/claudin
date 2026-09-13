/**
 * Column budget for the fullscreen side panel (a `fullscreenPanel` command
 * rendered beside the chat instead of over it — see ModalSlot).
 *
 * Pure (no React/ink imports) so it is unit-testable and so REPL, ModalSlot and
 * the tests can all read the same threshold.
 */

/**
 * Narrowest terminal that still gets a split. Below this each half would be
 * under 60 columns, where the diff is unreadable and the chat wraps every line,
 * so the panel takes the whole screen instead.
 */
export const SIDE_PANEL_MIN_COLUMNS = 120

export type SplitWidths = {
  /** Columns for the chat (transcript + prompt + footer). */
  leftCols: number
  /** Columns for the panel, including the one-column divider border. */
  panelCols: number
}

/** 50/50, with the odd column going to the panel. */
export function splitWidths(columns: number): SplitWidths {
  const leftCols = Math.floor(columns / 2)
  return { leftCols, panelCols: columns - leftCols }
}

/**
 * Columns between the panel's left edge and where its dialog actually draws:
 * the divider border (1), ModalSlot's own `paddingX` (1), and `Pane`'s
 * `paddingX` inside the modal (1). There is no border on the right, so that
 * side is inset by the two paddings only.
 */
const PANEL_BORDER = 1
const PANEL_PADDING = 2

/**
 * The two regions a mouse text selection may not cross, measured at each
 * side's CONTENT rectangle. The panel's is inset past its border and padding
 * so a highlight lines up with the dialog's boxes instead of overhanging them.
 *
 * `rowHi` is the last row the split covers: below it the prompt spans the full
 * width again, so a drag there belongs to neither side.
 */
export function selectionBands(
  columns: number,
  rowHi: number,
): readonly {
  lo: number
  hi: number
  rowHi: number
}[] {
  const { leftCols } = splitWidths(columns)
  return [
    { lo: 0, hi: leftCols - 1, rowHi },
    {
      lo: leftCols + PANEL_BORDER + PANEL_PADDING,
      hi: columns - 1 - PANEL_PADDING,
      rowHi,
    },
  ]
}

/** Whether `columns` is wide enough to show the panel beside the chat. */
export function canSplit(columns: number): boolean {
  return columns >= SIDE_PANEL_MIN_COLUMNS
}
