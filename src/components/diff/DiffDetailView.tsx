import type { StructuredPatchHunk } from 'diff'
import { resolve } from 'path'
import React, { useMemo } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { getCwd } from '../../utils/cwd.js'
import { readFileSafe } from '../../utils/file.js'
import { Divider } from '../design-system/Divider.js'
import { StructuredDiffList } from '../StructuredDiffList.js'

type Props = {
  filePath: string
  hunks: StructuredPatchHunk[]
  isLargeFile?: boolean
  isBinary?: boolean
  isTruncated?: boolean
  isUntracked?: boolean
  /** Original path when git detected a rename. */
  renamedFrom?: string
  /** Repo root the file lives under (multi-repo); defaults to the cwd. */
  root?: string
}

/**
 * Full-width single-file diff used by the narrow / non-fullscreen stacked
 * fallback. Renders through the shared `StructuredDiffList` (same theme-driven
 * colors / syntax highlighting as the transcript "Update(...)"). No inner
 * scroll — it relies on the outer transcript ScrollBox.
 */
export function DiffDetailView({
  filePath,
  hunks,
  isLargeFile,
  isBinary,
  isTruncated,
  isUntracked,
  renamedFrom,
  root,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()

  const { firstLine, fileContent } = useMemo(() => {
    if (!filePath) return { firstLine: null, fileContent: undefined }
    const content = readFileSafe(resolve(root || getCwd(), filePath))
    return {
      firstLine: content?.split('\n')[0] ?? null,
      fileContent: content ?? undefined,
    }
  }, [filePath, root])

  // Untracked file with no readable content to synthesize an all-green diff
  // from (e.g. unreadable / empty): fall back to the staging hint. When the
  // caller supplies synthetic added-hunks, fall through to render them.
  if (isUntracked && hunks.length === 0) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
          <Text dimColor> (new file)</Text>
        </Box>
        <Divider padding={4} />
        <Box flexDirection="column">
          <Text dimColor italic>
            New file not yet staged.
          </Text>
        </Box>
      </Box>
    )
  }

  if (isBinary) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
        </Box>
        <Divider padding={4} />
        <Text dimColor italic>
          Binary file - cannot display diff
        </Text>
      </Box>
    )
  }

  if (isLargeFile) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
        </Box>
        <Divider padding={4} />
        <Text dimColor italic>
          Large file - diff exceeds 1 MB limit
        </Text>
      </Box>
    )
  }

  // Pure rename (no content change → no hunks): name the source path instead of
  // the generic "No diff content".
  if (renamedFrom && hunks.length === 0) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{filePath}</Text>
        </Box>
        <Divider padding={4} />
        <Text dimColor italic>
          {`renamed from ${renamedFrom}`}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold>{filePath}</Text>
        {isTruncated && <Text dimColor> (truncated)</Text>}
      </Box>
      <Divider padding={4} />
      <Box flexDirection="column">
        {hunks.length === 0 ? (
          <Text dimColor>No diff content</Text>
        ) : (
          <StructuredDiffList
            hunks={hunks}
            dim={false}
            width={columns - 2 - 2}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        )}
      </Box>
      {isTruncated && (
        <Text dimColor italic>
          … diff truncated (exceeded 400 line limit)
        </Text>
      )}
    </Box>
  )
}
