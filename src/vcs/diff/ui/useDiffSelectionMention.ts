import { useEffect, useRef } from 'react'
import { measureAbsoluteRect, useSelection, type DOMElement } from 'src/terminal/ink.js'
import { rangeFromScreenRows } from 'src/vcs/diff/ui/rowLines.js'

type Deps = {
  /** Off unless the reviewer is a side panel showing a diff. */
  enabled: boolean
  /** The Diff pane's `<Box>` — its border is excluded when mapping rows. */
  paneRef: React.RefObject<DOMElement | null>
  /** Rendered row → new-file line, or null when the two disagreed. */
  rowLineIndex: (number | null)[] | null
  /** Index into the rendered rows of the pane's first visible row. */
  scrollOffset: number
  /** Content rows the pane shows. */
  height: number
  /** Called with the new-file line range a settled drag covered. */
  onRange: (range: { start: number; end: number }) => void
}

/**
 * Turn a finished MOUSE drag over the diff into a line range.
 *
 * Selecting with the mouse is what people actually do, and before this it only
 * highlighted and copied — the range still had to be redone with `v` to reach
 * the prompt. Here the drag itself carries it.
 *
 * Subscribing and treating "has a selection AND `isDragging === false`" as
 * drag-finish is `useCopyOnSelect`'s pattern (`src/terminal/hooks/
 * useCopyOnSelect.ts`), including its guard against firing twice for one drag;
 * a multi-click settles the same way, so double/triple-click works too.
 *
 * The mapping is screen rows → rendered rows → file lines: the pane's absolute
 * position comes from `measureAbsoluteRect` at event time (long after layout),
 * and `rangeFromScreenRows` clips the drag to the pane. A drag that started
 * outside the pane's rectangle is ignored, which is what keeps the file list,
 * the tab bar and the chat half from attaching anything.
 */
export function useDiffSelectionMention({
  enabled,
  paneRef,
  rowLineIndex,
  scrollOffset,
  height,
  onRange,
}: Deps): void {
  const selection = useSelection()
  // Everything below is read at event time, so hold it in refs rather than
  // re-subscribing on every scroll or re-render (which would also reset the
  // fired guard mid-drag).
  const latest = useRef({ rowLineIndex, scrollOffset, height, onRange, paneRef })
  latest.current = { rowLineIndex, scrollOffset, height, onRange, paneRef }

  useEffect(() => {
    if (!enabled) return
    let fired = false
    return selection.subscribe(() => {
      const state = selection.getState()
      if (state?.isDragging || !selection.hasSelection()) {
        fired = false
        return
      }
      if (fired) return
      fired = true

      const { rowLineIndex: index, scrollOffset: offset, height: rows, onRange: emit, paneRef: ref } = latest.current
      const node = ref.current
      if (!index || !node || !state?.anchor || !state.focus) return

      const rect = measureAbsoluteRect(node)
      // The section spans the full width; its first row is the title, so the
      // diff body starts one row down and the whole width is fair game.
      const anchor = state.anchor
      const insideX = anchor.col >= rect.left && anchor.col < rect.left + rect.width
      const insideY = anchor.row > rect.top && anchor.row < rect.top + rect.height
      if (!insideX || !insideY) return

      const range = rangeFromScreenRows(index, {
        firstContentRow: rect.top + 1,
        height: rows,
        scrollOffset: offset,
        fromRow: anchor.row,
        toRow: state.focus.row,
      })
      if (range) emit(range)
    })
  }, [enabled, selection])
}
