import React, { useLayoutEffect, useRef, useState } from 'react'
import { ModalContext } from 'src/terminal/contexts/modalContext.js'
import { TerminalSizeContext } from 'src/terminal/ink/components/TerminalSizeContext.js'
import { setSelectionColumnBands } from 'src/terminal/ink/selectionBands.js'
import { Box, type DOMElement, measureElement, Text, useTheme } from 'src/terminal/ink.js'
import type { Color } from 'src/terminal/ink/styles.js'
import { getTheme } from 'src/terminal/theme/theme.js'
import { selectionBands, splitWidths } from 'src/terminal/sidePanelLayout.js'

/** Rows of transcript context kept visible above the anchored pane's ▔ divider. */
export const MODAL_TRANSCRIPT_PEEK = 2

/**
 * First-frame guess for the bottom slot's height (prompt + status bar + hints),
 * used until the real height is measured. Deliberately generous: guessing too
 * BIG leaves a blank row for one frame, guessing too small clips the panel's
 * footer, and only one of those is noticeable.
 */
const ESTIMATED_BOTTOM_ROWS = 6

export type ModalMode =
  /** Today's default: bottom-anchored pane over the chat, with a 2-row peek. */
  | 'anchored'
  /** A `fullscreenPanel` command beside the chat, which reflows to the left half. */
  | 'split'
  /** A `fullscreenPanel` command on a terminal too narrow to split: it takes every row. */
  | 'takeover'

type Props = {
  mode: ModalMode
  /** The chat's scroll region (transcript). Narrowed to the left half when split. */
  left: React.ReactNode
  /** The prompt and its chrome. Spans the FULL width, below the split. */
  bottom: React.ReactNode
  /** Slash-command dialog content. null when nothing is showing. */
  modal: React.ReactNode
  /**
   * The side panel (a long-lived reviewer, today only `/diff`). Its own slot:
   * it outlives any dialog beside it, and the two can be on screen together.
   */
  panel?: React.ReactNode
  rows: number
  columns: number
  scrollRef: React.RefObject<import('src/terminal/ink/components/ScrollBox.js').ScrollBoxHandle | null> | null
}

/**
 * Where a slash-command dialog is rendered in fullscreen. Three shapes:
 *
 * - **anchored** — an absolute, bottom-anchored pane painting over the chat and
 *   the bottom slot, keeping `MODAL_TRANSCRIPT_PEEK` rows of transcript and a ▔
 *   divider above it. Every command gets this unless it asks for more.
 * - **takeover** — the same pane grown to every row, with no peek and no
 *   divider. It needs an explicit `height` so the `opaque` fill covers the whole
 *   screen even when the dialog is short; `opaque` writes spaces across the
 *   box's interior before painting children (`render-node-to-output.ts`), which
 *   is why nothing behind it has to be unmounted.
 * - **split** — the panel sits *beside* the chat instead of over it, so it is
 *   NOT absolute: the transcript is re-parented into a narrower column and
 *   re-provided a smaller `TerminalSizeContext`, which is what makes it reflow
 *   rather than being clipped at the divider. Only the TRANSCRIPT is narrowed —
 *   the prompt keeps the full width below both columns, so the divider stops at
 *   the top of the input rather than running to the bottom of the screen.
 *
 * `ModalContext` is provided in all three so `Pane`/`Dialog` inside skip their
 * own top-level frame and size to the rows actually available.
 */
export function ModalSlot({
  mode,
  left,
  bottom,
  modal,
  panel,
  rows,
  columns,
  scrollRef,
}: Props): React.ReactNode {
  const split = panel != null && mode === 'split'
  // A tint that separates the panel from the chat beside it. Empty on the
  // terminal/ansi themes, which inherit the user's own palette.
  const [themeName] = useTheme()
  const panelBackground = getTheme(themeName).sidePanelBackground

  // The panel stretches to whatever the row above the prompt is worth, and the
  // dialog inside needs that number for its own fixed-height panes. Yoga knows
  // it; we read it back after the commit. One frame late by construction (the
  // layout pass runs after React's), which is invisible because the bottom
  // slot's height only changes when the prompt gains or loses a line.
  const splitRef = useRef<DOMElement | null>(null)
  const [splitRows, setSplitRows] = useState(() =>
    Math.max(1, rows - ESTIMATED_BOTTOM_ROWS),
  )
  useLayoutEffect(() => {
    if (!split) return
    const node = splitRef.current
    if (!node) return
    const measured = measureElement(node).height
    if (measured > 0) setSplitRows(prev => (prev === measured ? prev : measured))
  })

  // Mouse text selection is row-wide by default, which would drag a highlight
  // (and a copy) straight across the divider into the chat. Publishing the two
  // regions pins a drag to whichever one it started in; anything but the split
  // clears them back to one full-width region. The bands stop at the prompt,
  // which is full width again and must not be clamped to either side.
  useLayoutEffect(() => {
    if (!split) {
      setSelectionColumnBands(null)
      return
    }
    setSelectionColumnBands(selectionBands(columns, splitRows - 1))
    return () => setSelectionColumnBands(null)
  }, [split, columns, splitRows])

  if (modal == null && panel == null) {
    return (
      <>
        {left}
        {bottom}
      </>
    )
  }

  /**
   * The absolute, bottom-anchored pane. `takeover` grows it to every row and
   * drops the peek + ▔ divider. A dialog beside a split keeps the normal
   * anchored shape AND its full width: it is transient, and clamping it to the
   * chat column would need a width and an offset `Pane` has never had.
   */
  const anchoredPane = (
    content: React.ReactNode,
    takeover: boolean,
  ): React.ReactNode => {
    const peek = takeover ? 0 : MODAL_TRANSCRIPT_PEEK
    const dividerRows = takeover ? 0 : 1
    return (
      <ModalContext
        value={{
          rows: rows - peek - dividerRows,
          columns: columns - 4,
          scrollRef,
        }}
      >
        <Box
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          height={takeover ? rows : undefined}
          maxHeight={rows - peek}
          flexDirection="column"
          overflow="hidden"
          opaque={true}
        >
          {takeover ? null : (
            <Box flexShrink={0}>
              <Text color="permission">{'\u2594'.repeat(columns)}</Text>
            </Box>
          )}
          <Box flexDirection="column" paddingX={2} flexShrink={0} overflow="hidden">
            {content}
          </Box>
        </Box>
      </ModalContext>
    )
  }

  // Rendered last in every arrangement, so a dialog paints over the panel
  // rather than under it.
  const dialog = modal == null ? null : anchoredPane(modal, false)

  if (split) {
    const { leftCols, panelCols } = splitWidths(columns)
    return (
      <Box flexDirection="column" flexGrow={1} width="100%" overflow="hidden">
        <Box
          ref={splitRef}
          flexDirection="row"
          flexGrow={1}
          width="100%"
          overflow="hidden"
        >
          <TerminalSizeContext value={{ columns: leftCols, rows: splitRows }}>
            <Box
              flexDirection="column"
              width={leftCols}
              flexShrink={0}
              overflow="hidden"
            >
              {left}
            </Box>
          </TerminalSizeContext>
          <ModalContext
            value={{
              // The rows this column is actually worth, and the usable width
              // before `Pane`'s own paddingX — the same convention the anchored
              // arrangement uses (`columns - 4` there): panelCols minus the
              // left border and our paddingX={1}.
              rows: splitRows,
              columns: panelCols - 3,
              scrollRef,
            }}
          >
            <Box
              flexDirection="column"
              width={panelCols}
              flexShrink={0}
              overflow="hidden"
              borderStyle="single"
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              // Structure, not state: the divider stays neutral. Which side
              // holds the keyboard is said by the dialog's own section rules.
              borderColor="subtle"
              backgroundColor={panelBackground ? (panelBackground as Color) : undefined}
            >
              <Box flexDirection="column" paddingX={1} flexShrink={0} overflow="hidden">
                {panel}
              </Box>
            </Box>
          </ModalContext>
        </Box>
        {bottom}
        {dialog}
      </Box>
    )
  }

  return (
    <>
      {left}
      {bottom}
      {panel == null ? null : anchoredPane(panel, mode === 'takeover')}
      {dialog}
    </>
  )
}
