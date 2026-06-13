import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'
import type { DOMElement } from '../dom.js'

type ViewportEntry = {
  /**
   * Whether the element is currently within the terminal viewport
   */
  isVisible: boolean
}

/**
 * Compute, fresh from the live yoga tree + terminal size, whether `element`
 * sits within the terminal viewport. Returns `null` when layout isn't ready
 * (no yoga node / no terminal size) so callers can keep their previous value.
 *
 * Walks the DOM parent chain (not yoga.getParent()) so we can detect scroll
 * containers and subtract their scrollTop. Yoga computes layout positions
 * without scroll offset — scrollTop is applied at render time. Without this, an
 * element inside a ScrollBox whose yoga position exceeds terminalRows would be
 * considered offscreen even when scrolled into view (e.g., the spinner in
 * fullscreen mode after enough messages accumulate).
 */
function computeVisible(element: DOMElement | null, rows: number | undefined): boolean | null {
  if (!element?.yogaNode || rows === undefined) return null

  const height = element.yogaNode.getComputedHeight()

  let absoluteTop = element.yogaNode.getComputedTop()
  let parent: DOMElement | undefined = element.parentNode
  let root = element.yogaNode
  while (parent) {
    if (parent.yogaNode) {
      absoluteTop += parent.yogaNode.getComputedTop()
      root = parent.yogaNode
    }
    // scrollTop is only ever set on scroll containers (by ScrollBox + renderer).
    // Non-scroll nodes have undefined scrollTop → falsy fast-path.
    if (parent.scrollTop) absoluteTop -= parent.scrollTop
    parent = parent.parentNode
  }

  // Only the root's height matters
  const screenHeight = root.getComputedHeight()

  const bottom = absoluteTop + height
  // When content overflows the viewport (screenHeight > rows), the
  // cursor-restore at frame end scrolls one extra row into scrollback.
  // log-update.ts accounts for this with scrollbackRows = viewportY + 1.
  // We must match, otherwise an element at the boundary is considered
  // "visible" here (animation keeps ticking) but its row is treated as
  // scrollback by log-update (content change → full reset → flicker).
  const cursorRestoreScroll = screenHeight > rows ? 1 : 0
  const viewportY = Math.max(0, screenHeight - rows) + cursorRestoreScroll
  const viewportBottom = viewportY + rows
  return bottom > viewportY && absoluteTop < viewportBottom
}

/**
 * Hook to detect if a component is within the terminal viewport.
 *
 * Returns a callback ref, a viewport entry object, and a live-probe callback.
 * Attach the ref to the component you want to track.
 *
 * The entry is updated during the layout phase (useLayoutEffect) so callers
 * always read fresh values during render. Visibility changes do NOT trigger
 * re-renders on their own — callers that re-render for other reasons (e.g.
 * animation ticks, state changes) will pick up the latest value naturally.
 * This avoids infinite update loops when combined with other layout effects
 * that also call setState.
 *
 * `isVisibleNow()` recomputes visibility straight from the current yoga tree,
 * independent of any render. It exists for animation loops that freeze their
 * owning component offscreen (so the layout effect stops running and `entry`
 * goes stale): the loop can poll this each tick to notice when the element
 * scrolls back into view and resume — see useAnimationFrame.
 *
 * @example
 * const [ref, entry] = useTerminalViewport()
 * return <Box ref={ref}><Animation enabled={entry.isVisible}>...</Animation></Box>
 */
export function useTerminalViewport(): [
  ref: (element: DOMElement | null) => void,
  entry: ViewportEntry,
  isVisibleNow: () => boolean,
] {
  const terminalSize = useContext(TerminalSizeContext)
  const elementRef = useRef<DOMElement | null>(null)
  const entryRef = useRef<ViewportEntry>({ isVisible: true })
  // Keep the latest rows in a ref so isVisibleNow() stays stable yet reads
  // fresh terminal dimensions without being recreated on every resize.
  const rowsRef = useRef<number | undefined>(terminalSize?.rows)
  rowsRef.current = terminalSize?.rows

  const setElement = useCallback((el: DOMElement | null) => {
    elementRef.current = el
  }, [])

  const isVisibleNow = useCallback((): boolean => {
    const visible = computeVisible(elementRef.current, rowsRef.current)
    return visible ?? entryRef.current.isVisible
  }, [])

  // Runs on every render because yoga layout values can change
  // without React being aware. Only updates the ref — no setState
  // to avoid cascading re-renders during the commit phase.
  // Walks the DOM ancestor chain fresh each time to avoid holding stale
  // references after yoga tree rebuilds.
  useLayoutEffect(() => {
    const visible = computeVisible(elementRef.current, terminalSize?.rows)
    if (visible !== null && visible !== entryRef.current.isVisible) {
      entryRef.current = { isVisible: visible }
    }
  })

  return [setElement, entryRef.current, isVisibleNow]
}
