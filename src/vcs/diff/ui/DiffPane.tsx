import React from 'react'
import { Box, RawAnsi, Text } from 'src/terminal/ink.js'
import { plural } from 'src/shared/text/stringUtils.js'
import { expectColorDiff } from 'src/vcs/diff/structured/colorDiff.js'
import type { DiffSegment } from 'src/vcs/diff/ui/types.js'

export type DiffRowsOptions = {
  filePath: string
  firstLine: string | null
  fileContent?: string
  /** Inner content width passed to ColorDiff (it wraps to this). */
  width: number
  /** Active theme name (from useTheme). */
  theme: string
}

/**
 * Flatten the collapsible segments into final, wrapped terminal rows using the
 * same `ColorDiff` path `StructuredDiff` uses, so colors / word-diff / syntax
 * highlighting follow the active theme. Collapsed gaps become `··· N lines`
 * marker rows.
 *
 * Working on already-rendered rows (rather than React hunk subtrees) lets the
 * caller window the diff to a fixed height in ANY render mode — the alt-screen
 * `ScrollBox` viewport culling does not engage in inline / main-screen-rewrite
 * mode, which let tall diffs grow the dialog. Fail-open: if the color module is
 * unavailable, the raw unified-diff lines are emitted uncolored.
 */
export function renderDiffRows(
  segments: DiffSegment[],
  { filePath, firstLine, fileContent, width, theme }: DiffRowsOptions,
): string[] {
  const ColorDiff = expectColorDiff()
  const ruleWidth = Math.max(0, width - 16)
  const rows: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'gap') {
      rows.push(
        `··· ${segment.lineCount} ${plural(
          segment.lineCount,
          'line',
        )} ${'─'.repeat(ruleWidth)}`,
      )
      continue
    }
    const lines = ColorDiff
      ? new ColorDiff(
          segment.hunk,
          firstLine,
          filePath,
          fileContent ?? null,
        ).render(theme, width, false)
      : null
    if (lines) rows.push(...lines)
    else for (const raw of segment.hunk.lines) rows.push(raw)
  }
  return rows
}

type Props = {
  /** Pre-rendered diff rows (from renderDiffRows). */
  rows: string[]
  /** First visible row (clamped here defensively). */
  scrollOffset: number
  /** Viewport height in rows. */
  height: number
  /** Inner content width. */
  width: number
}

/**
 * The collapsible diff body for the Local Changes tab. Renders a fixed-height
 * window of pre-rendered rows; the caller owns the scroll offset (↑/↓/PgUp/
 * PgDn). Bounded height in every render mode — no ScrollBox dependency.
 */
export function DiffPane({
  rows,
  scrollOffset,
  height,
  width,
}: Props): React.ReactNode {
  if (rows.length === 0) return <Text dimColor>No diff content</Text>
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - height)))
  const visible = rows.slice(start, start + height)
  return (
    <Box flexDirection="column" width="100%">
      <RawAnsi lines={visible} width={width} />
    </Box>
  )
}
