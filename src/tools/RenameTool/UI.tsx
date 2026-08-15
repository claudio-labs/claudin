import * as React from 'react'
import { useState } from 'react'
import { FilePathLink } from 'src/components/FilePathLink.js'
import { StructuredDiffList } from 'src/components/StructuredDiffList.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { Box, Text } from 'src/ink.js'
import { getDisplayPath } from 'src/utils/fs/file.js'
import type { RenameFileResult, RenameOutput } from 'src/tools/RenameTool/rename.js'

/**
 * Diff lines rendered inline before the rest collapses into a tail line.
 * Budgeted in lines rather than hunks or files because that is what actually
 * floods the transcript: a rename's hunks are near-identical, and one file with
 * eight sites costs as much room as eight files with one each. `ctrl+o`
 * (verbose) lifts the cap.
 */
const MAX_INLINE_DIFF_LINES = 32

/**
 * One file's changed lines, in the same layout the Edit tool uses: the path,
 * the added/removed counts, then the hunks themselves. The path is a link so
 * the user can jump straight to a file the model rewrote without ever showing
 * it to them.
 */
function FileDiff({
  file,
  width,
}: {
  file: RenameFileResult
  width: number
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{'⎿  '}</Text>
        <Text dimColor>
          <FilePathLink filePath={file.absPath}>
            {getDisplayPath(file.absPath)}
          </FilePathLink>
        </Text>
        <Text color="success">{'  +'}{file.additions}</Text>
        <Text color="error">{' −'}{file.deletions}</Text>
      </Box>
      {/*
        StructuredDiffList returns one node per hunk, so this Box has to stack
        them. Without the explicit column direction they lay out side by side
        and a two-hunk file renders as overlapping columns.
      */}
      <Box flexDirection="column" marginLeft={3}>
        <StructuredDiffList
          hunks={file.structuredPatch}
          dim={false}
          width={width}
          filePath={file.absPath}
          firstLine={null}
        />
      </Box>
    </Box>
  )
}

// The caveats are the point of this row: a `~` file had its strings and
// comments rewritten too, and an unreadable candidate was skipped entirely.
// Both are silent in the file list, so they get their own line, always visible
// rather than hidden behind the expand toggle.
function Caveats({ output }: { output: RenameOutput }): React.ReactNode {
  if (output.type !== 'apply') return null
  const lines: string[] = []
  if (output.skippedMasked > 0) {
    lines.push(
      `${output.skippedMasked} occurrence${
        output.skippedMasked === 1 ? '' : 's'
      } in strings/comments left untouched`,
    )
  }
  if (output.excluded > 0) lines.push(`${output.excluded} excluded`)
  if (lines.length === 0 && output.unparsedFiles.length === 0) return null
  return (
    <Box flexDirection="column">
      {lines.length > 0 ? <Text dimColor>{lines.join(' · ')}</Text> : null}
      {output.unparsedFiles.length > 0 ? (
        <Text color="warning">
          {`no string/comment analysis for ${output.unparsedFiles.join(
            ', ',
          )} — strings and comments there were renamed too`}
        </Text>
      ) : null}
      {output.unreadable.length > 0 ? (
        <Text color="warning">
          {`could not read ${output.unreadable.join(', ')} — left untouched`}
        </Text>
      ) : null}
    </Box>
  )
}

function RenameResultMessage({
  output,
  verbose,
}: {
  output: Extract<RenameOutput, { type: 'apply' }>
  verbose: boolean
}): React.ReactNode {
  const [collapsed, setCollapsed] = useState(false)
  const [hover, setHover] = useState(false)
  const { columns } = useTerminalSize()
  const fileCount = output.files.length

  const shown: RenameFileResult[] = []
  let lines = 0
  if (!collapsed) {
    for (const file of output.files) {
      if (!verbose && lines >= MAX_INLINE_DIFF_LINES) break
      shown.push(file)
      lines += file.structuredPatch.reduce((n, h) => n + h.lines.length, 0)
    }
  }
  const hiddenFiles = output.files.length - shown.length

  return (
    <Box flexDirection="column" marginLeft={3}>
      <Box
        flexDirection="row"
        onClick={() => setCollapsed(v => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Text dimColor={!hover}>
          {'Renamed '}
          <Text bold>{output.siteCount}</Text>
          {` site${output.siteCount === 1 ? '' : 's'} in `}
          <Text bold>{fileCount}</Text>
          {` file${fileCount === 1 ? '' : 's'}`}
        </Text>
      </Box>
      {shown.map(file => (
        <FileDiff key={file.absPath} file={file} width={columns - 12} />
      ))}
      {hiddenFiles > 0 ? (
        <Text dimColor>
          {`… and ${hiddenFiles} more file${
            hiddenFiles === 1 ? '' : 's'
          } — run /diff to review full changes`}
        </Text>
      ) : null}
      <Caveats output={output} />
    </Box>
  )
}

export function renderToolResultMessage(
  output: RenameOutput,
  _progressMessagesForMessage: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  // A preview is already a formatted block; the model-facing text is what the
  // user should see, so the transcript renders it verbatim.
  if (output.type === 'preview') {
    return (
      <Box flexDirection="column" marginLeft={3}>
        <Text dimColor>{output.text}</Text>
      </Box>
    )
  }
  if (output.siteCount === 0) {
    return (
      <Box marginLeft={3}>
        <Text dimColor>No site renamed.</Text>
      </Box>
    )
  }
  return <RenameResultMessage output={output} verbose={verbose} />
}
