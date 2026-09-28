import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { Box, NoSelect, Text } from 'src/terminal/ink.js'
import type { Theme } from 'src/terminal/theme/theme.js'
import { type FallbackRow, layoutFallback } from 'src/vcs/diff/structured/fallback/rows.js'
import { LINE_MARKERS, type LineKind } from 'src/vcs/diff/structured/hunk/lines.js'
import { sanitizeHunk } from 'src/vcs/diff/structured/hunk/sanitize.js'

type Props = { patch: StructuredPatchHunk; dim: boolean; width: number }

/** The theme keys a kind of row is painted with. Context rows and notes keep the terminal's own colours. */
type Palette = { fill?: keyof Theme; dimmedFill?: keyof Theme; wordFill?: keyof Theme; ink?: keyof Theme }

const PALETTES: Record<LineKind, Palette> = {
  added: { fill: 'diffAdded', dimmedFill: 'diffAddedDimmed', wordFill: 'diffAddedWord', ink: 'text' },
  removed: { fill: 'diffRemoved', dimmedFill: 'diffRemovedDimmed', wordFill: 'diffRemovedWord', ink: 'text' },
  context: {},
  note: {},
}

/** Draws one hunk without syntax highlighting. */
export function StructuredDiffFallback({ patch, dim, width }: Props): React.ReactNode {
  const layout = React.useMemo(() => layoutFallback(sanitizeHunk(patch), width, dim), [patch, width, dim])
  return (
    <Box flexDirection="column">
      {layout.rows.map((row, index) => (
        <FallbackRowView key={index} row={row} numberWidth={layout.numberWidth} dim={dim} />
      ))}
    </Box>
  )
}

type RowProps = { row: FallbackRow; numberWidth: number; dim: boolean }

// The rows arrive wrapped to the width, so the gutter and the code never wrap
// on their own. The gutter is fenced off, so a fullscreen drag copies only code.
function FallbackRowView({ row, numberWidth, dim }: RowProps): React.ReactNode {
  const palette = PALETTES[row.kind]
  const fill = dim ? palette.dimmedFill : palette.fill
  const quietCode = dim || row.kind === 'note'
  const number = row.number === null ? '' : String(row.number)
  return (
    <Box flexDirection="row">
      <NoSelect fromLeftEdge flexShrink={0}>
        <Text color={palette.ink} backgroundColor={fill} dimColor={quietCode || row.kind === 'context'}>
          {`${number.padStart(numberWidth)} ${LINE_MARKERS[row.kind]}`}
        </Text>
      </NoSelect>
      <Text color={palette.ink} backgroundColor={fill} dimColor={quietCode}>
        {row.spans.map((span, index) =>
          span.tag === 'changed' ? (
            <Text key={index} backgroundColor={palette.wordFill}>
              {span.text}
            </Text>
          ) : (
            span.text
          ),
        )}
        {' '.repeat(row.fill)}
      </Text>
    </Box>
  )
}
