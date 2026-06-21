import React from 'react'
import {
  FileIndex,
  type SearchResult,
} from '../../native-ts/file-index/index.js'
import { Box, Text } from '../../ink.js'
import { truncateStartToWidth } from '../../utils/format.js'

/** Build a fzf-style index over a flat path list (used by the / quick-open). */
export function buildFileIndex(paths: string[]): FileIndex {
  const index = new FileIndex()
  index.loadFromFileList(paths)
  return index
}

type Props = {
  query: string
  results: SearchResult[]
  selected: number
  width: number
  /** Max result rows to show. */
  maxVisible: number
}

/** Center a fixed window of rows on the selected one. */
function windowRange(
  total: number,
  selected: number,
  maxVisible: number,
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total }
  let start = Math.max(0, selected - Math.floor(maxVisible / 2))
  const end = Math.min(total, start + maxVisible)
  start = Math.max(0, end - maxVisible)
  return { start, end }
}

/** The `/` quick-open overlay: a query line + a scrollable match list. */
export function FuzzyOverlay({
  query,
  results,
  selected,
  width,
  maxVisible,
}: Props): React.ReactNode {
  const { start, end } = windowRange(results.length, selected, maxVisible)
  const budget = Math.max(4, width - 4)
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{'❯ '}</Text>
        {query}
        <Text dimColor>▏</Text>
      </Text>
      {results.length === 0 ? (
        <Text dimColor>{query ? 'no matches' : 'type to search files'}</Text>
      ) : (
        results.slice(start, end).map((r, i) => {
          const idx = start + i
          const isSel = idx === selected
          return (
            <Text key={r.path} inverse={isSel} bold={isSel} dimColor={!isSel}>
              {`${isSel ? '▸ ' : '  '}${truncateStartToWidth(r.path, budget)}`}
            </Text>
          )
        })
      )}
    </Box>
  )
}
