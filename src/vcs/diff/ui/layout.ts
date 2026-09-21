/**
 * Row budget for the Local Changes tab's **takeover** layout — the file list
 * stacked on top of a full-width diff, both in bordered panes.
 *
 * Pure (no React/ink imports) for the same reason `fileTree.ts` is: importing a
 * `.tsx` pulls in `ink.js` → the build-time-stubbed analytics module, which is
 * unresolvable under the test runner.
 */

/** Most rows the file list may take, however many files changed. */
export const TAKEOVER_LIST_MAX_ROWS = 10

/** Fewest rows the diff body keeps, however long the file list is. */
const MIN_DIFF_ROWS = 3

/**
 * Rows the Dialog column spends around ANY body: the tab bar, the footer, and
 * the `gap={1}` it lays between each of its children. The fifth is a bottom
 * margin the stacked layout keeps too, so the footer never lands on the
 * panel's very last line.
 */
const DIALOG_CHROME_ROWS = 5

/** What a source / project line above the body costs: the line, plus its gap. */
const HEADER_LINE_ROWS = 2

/**
 * Rows the body may take inside the panel.
 *
 * `contentHeight` cannot stand in for this on the Log tab: it is sized for the
 * stacked Local layout, which always draws a source line and two section
 * rules. Reusing it there left the inline arrangement three rows short and the
 * side-by-side one two, and parked the hints under them three or four rows
 * above the bottom of the panel.
 *
 * @param dialogRows    Rows the dialog is worth (`ModalContext.rows`).
 * @param hasHeaderLine Whether a source / project line sits above the body.
 * @param ownChromeRows Rows the body element spends on itself — the inline
 *   layout's `marginTop` (1), or a bordered pane's two edges (2).
 */
export function computeDialogBodyRows(
  dialogRows: number,
  hasHeaderLine: boolean,
  ownChromeRows: number,
): number {
  return Math.max(
    MIN_DIFF_ROWS,
    dialogRows -
      DIALOG_CHROME_ROWS -
      ownChromeRows -
      (hasHeaderLine ? HEADER_LINE_ROWS : 0),
  )
}

export type TakeoverLayout = {
  /** Interior height of the Files pane (border excluded). */
  listInner: number
  /**
   * `maxVisible` for `DiffFileList`. Two rows smaller than `listInner` when the
   * list overflows, because the component renders its `↑ N more` / `↓ N more`
   * indicators *in addition to* `maxVisible` rows.
   */
  listMaxVisible: number
  /** Interior height of the Diff pane (border excluded). */
  diffInner: number
}

/**
 * @param contentHeight Interior height one pane would get in the split layout —
 *   `rows - 9` under the takeover. The two stacked panes share
 *   `contentHeight + 2` rows, i.e. `contentHeight - 2` of interior once both
 *   borders are paid for.
 * @param treeRowCount Visible rows in the collapse-aware tree (files, folders
 *   and per-repo group headers alike).
 */
export function computeTakeoverLayout(
  contentHeight: number,
  treeRowCount: number,
): TakeoverLayout {
  const interior = Math.max(
    MIN_DIFF_ROWS + 1,
    // Each section spends ONE row: a top-border rule carrying its title. The
    // two fully bordered panes this replaced spent four.
    contentHeight,
  )
  // Auto-fit to the number of files, capped — and never zero, so an empty
  // working tree still has a row for its "Working tree is clean" message.
  // The half-interior term only bites on a short terminal, where the flat cap
  // would leave the diff on its 3-row floor (24 rows gave the list 10 and the
  // diff 3); above ~26 rows the cap wins and it is inert.
  const listInner = Math.max(
    1,
    Math.min(
      treeRowCount,
      TAKEOVER_LIST_MAX_ROWS,
      Math.max(1, Math.floor(interior / 2)),
      interior - MIN_DIFF_ROWS,
    ),
  )
  return {
    listInner,
    listMaxVisible:
      treeRowCount > listInner ? Math.max(1, listInner - 2) : listInner,
    diffInner: Math.max(MIN_DIFF_ROWS, interior - listInner),
  }
}
