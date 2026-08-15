import React, { useMemo } from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import type { CommitFile } from 'src/vcs/git/gitLog.js'
import { getDiffGlyphs } from 'src/vcs/diff/ui/glyphs.js'

type Props = {
  /** Files changed in the selected commit; `null` while loading. */
  files: CommitFile[] | null
  /** Viewport height in rows. */
  maxVisible: number
  /** First visible row (clamped here defensively). */
  scrollOffset: number
}

/**
 * Read-only list of files changed in the selected commit. Presentational — the
 * debounced fetch lives in `useCommitFiles` so the dialog can also derive the
 * commit-wide add/remove totals for the pane border. Windowed to a fixed
 * height (the caller owns the scroll offset) so a wide commit neither grows
 * the dialog inline nor gets silently clipped by the split pane's overflow.
 */
export function CommitFileList({
  files,
  maxVisible,
  scrollOffset,
}: Props): React.ReactNode {
  const glyphs = useMemo(getDiffGlyphs, [])

  if (files === null) {
    return <Text dimColor>Loading…</Text>
  }
  if (files.length === 0) {
    return <Text dimColor>No files</Text>
  }

  const start = Math.max(
    0,
    Math.min(scrollOffset, Math.max(0, files.length - maxVisible)),
  )
  const end = Math.min(files.length, start + maxVisible)

  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{` ↑ ${start} more`}</Text>}
      {files.slice(start, end).map(file => {
        const icon = glyphs.fileIcon(file.path)
        return (
          <Box key={file.path} flexDirection="row">
            <Text>{icon ? `${icon} ` : ''}{file.path}</Text>
            <Box flexGrow={1} />
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
        )
      })}
      {end < files.length && (
        <Text dimColor>{` ↓ ${files.length - end} more`}</Text>
      )}
    </Box>
  )
}
