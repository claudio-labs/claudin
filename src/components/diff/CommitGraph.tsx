import React, { useMemo } from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import type { GitLogRow } from 'src/services/git/gitLog.js'
import { entityColor } from 'src/components/diff/entityColor.js'

/** Split a decoration name into a display label + whether it's a tag. */
function refParts(ref: string): { label: string; isTag: boolean } {
  return ref.startsWith('tag: ')
    ? { label: ref.slice(5), isTag: true }
    : { label: ref, isTag: false }
}

/** Center a fixed-size window of `maxVisible` rows on the selected row. */
function windowRange(
  total: number,
  selected: number,
  maxVisible: number,
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total }
  let start = Math.max(0, selected - Math.floor(maxVisible / 2))
  let end = start + maxVisible
  if (end > total) {
    end = total
    start = Math.max(0, end - maxVisible)
  }
  return { start, end }
}

type Props = {
  rows: GitLogRow[]
  /** Index into `rows` of the selected commit row. */
  selectedRow: number
  maxVisible: number
  loading: boolean
  hasMore: boolean
}

/**
 * The git graph rail for the Log tab. Renders git's own graph glyphs
 * (`--graph`) plus short hash + author + subject + ref decorations, windowed
 * to the available rows with the selected commit centered.
 */
export function CommitGraph({
  rows,
  selectedRow,
  maxVisible,
  loading,
  hasMore,
}: Props): React.ReactNode {
  const { start, end } = useMemo(
    () => windowRange(rows.length, selectedRow, maxVisible),
    [rows.length, selectedRow, maxVisible],
  )

  if (rows.length === 0) {
    return <Text dimColor>{loading ? 'Loading…' : 'No commits'}</Text>
  }

  const visible = rows.slice(start, end)

  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{` ↑ ${start} more`}</Text>}
      {visible.map((row, i) => {
        const idx = start + i
        if (!row.isCommit) {
          return (
            <Text key={idx} dimColor wrap="truncate">
              {row.graphPrefix}
            </Text>
          )
        }
        if (idx === selectedRow) {
          // Selected row: single inverse Text (no nested colors so the
          // highlight is uniform across terminals). Tags lose their "tag: "
          // prefix to match the colored rows below.
          const refsText =
            row.refs.length > 0
              ? ' ' + row.refs.map(r => refParts(r).label).join(' ')
              : ''
          return (
            <Text key={idx} wrap="truncate" inverse bold>
              {`${row.graphPrefix}${row.shortHash} ${row.author}${refsText} ${row.subject}`}
            </Text>
          )
        }
        return (
          <Text key={idx} wrap="truncate">
            {row.graphPrefix}
            <Text color="permission">{row.shortHash}</Text>
            {' '}
            <Text color={entityColor(row.author)} bold>
              {row.author}
            </Text>
            {/* Tags in green, branches/HEAD in amber — before the subject. */}
            {row.refs.map((ref, r) => {
              const { label, isTag } = refParts(ref)
              return (
                <Text key={r} color={isTag ? 'success' : 'warning'} bold>
                  {` ${label}`}
                </Text>
              )
            })}
            {` ${row.subject}`}
          </Text>
        )
      })}
      {end < rows.length ? (
        <Text dimColor>{` ↓ ${rows.length - end} more`}</Text>
      ) : hasMore ? (
        <Text dimColor>{loading ? ' ↓ loading…' : ' ↓ more'}</Text>
      ) : null}
    </Box>
  )
}
