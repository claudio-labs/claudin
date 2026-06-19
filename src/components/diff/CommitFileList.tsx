import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import type { CommitFile } from '../../utils/gitLog.js'
import { getDiffGlyphs } from './glyphs.js'

type Props = {
  /** Files changed in the selected commit; `null` while loading. */
  files: CommitFile[] | null
}

/**
 * Read-only list of files changed in the selected commit. Presentational — the
 * debounced fetch lives in `useCommitFiles` so the dialog can also derive the
 * commit-wide add/remove totals for the pane border.
 */
export function CommitFileList({ files }: Props): React.ReactNode {
  const glyphs = useMemo(getDiffGlyphs, [])

  if (files === null) {
    return <Text dimColor>Loading…</Text>
  }
  if (files.length === 0) {
    return <Text dimColor>No files</Text>
  }

  return (
    <Box flexDirection="column">
      {files.map(file => {
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
    </Box>
  )
}
