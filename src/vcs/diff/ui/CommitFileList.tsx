import React, { useMemo } from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import type { CommitFile } from 'src/vcs/git/gitLog.js'
import { getDiffGlyphs } from 'src/vcs/diff/ui/glyphs.js'

type Props = {
  /** Files changed in the selected commit; `null` while loading. */
  files: CommitFile[] | null
  /** Viewport height in rows. */
  maxVisible: number
  /** Index of the highlighted file (Enter/→ drills into its diff). */
  selectedIndex: number
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

/**
 * List of files changed in the selected commit. Presentational — the
 * debounced fetch lives in `useCommitFiles` so the dialog can also derive the
 * commit-wide add/remove totals for the pane border. Windowed to a fixed
 * height (the caller owns the selection) so a wide commit neither grows
 * the dialog inline nor gets silently clipped by the split pane's overflow.
 * The highlighted row is what Enter/→ opens, mirroring the Local tab's list.
 */
export function CommitFileList({
  files,
  maxVisible,
  selectedIndex,
}: Props): React.ReactNode {
  const glyphs = useMemo(getDiffGlyphs, [])

  if (files === null) {
    return <Text dimColor>Loading…</Text>
  }
  if (files.length === 0) {
    return <Text dimColor>No files</Text>
  }

  const { start, end } = windowRange(files.length, selectedIndex, maxVisible)

  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{` ↑ ${start} more`}</Text>}
      {files.slice(start, end).map((file, i) => {
        const isSelected = start + i === selectedIndex
        const lead = isSelected ? `${glyphs.pointer} ` : '  '
        const icon = glyphs.fileIcon(file.path)
        return (
          <Box key={file.path} flexDirection="row">
            <Box flexShrink={1} overflow="hidden">
              <Text wrap="truncate" bold={isSelected} inverse={isSelected}>
                {`${lead}${icon ? `${icon} ` : ''}${file.path}`}
              </Text>
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0}>
              {file.isBinary ? (
                <Text dimColor italic>
                  Binary
                </Text>
              ) : (
                <Text>
                  {file.added > 0 && (
                    <Text color="diffAddedWord">+{file.added}</Text>
                  )}
                  {file.added > 0 && file.removed > 0 ? ' ' : ''}
                  {file.removed > 0 && (
                    <Text color="diffRemovedWord">-{file.removed}</Text>
                  )}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {end < files.length && (
        <Text dimColor>{` ↓ ${files.length - end} more`}</Text>
      )}
    </Box>
  )
}
