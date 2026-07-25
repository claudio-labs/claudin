import * as React from 'react'
import { useState } from 'react'
import { FilePathLink } from '../../components/FilePathLink.js'
import { Box, Text } from '../../ink.js'
import { getDisplayPath } from '../../utils/file.js'
import type { RenameOutput } from './rename.js'

/**
 * One file row, revealed under the summary. The path is a link so the user can
 * jump straight to a file the model rewrote without ever showing it to them.
 */
function FileRow({
  relPath,
  sites,
}: {
  relPath: string
  sites: number
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Text dimColor>{'⎿  '}</Text>
      <Text dimColor>
        <FilePathLink filePath={relPath}>
          {getDisplayPath(relPath)}
        </FilePathLink>
      </Text>
      <Text dimColor>{'  '}</Text>
      <Text bold>{sites}</Text>
      <Text dimColor>{` site${sites === 1 ? '' : 's'}`}</Text>
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
  const [expanded, setExpanded] = useState(false)
  const [hover, setHover] = useState(false)
  const show = verbose || expanded
  const fileCount = output.files.length
  return (
    <Box flexDirection="column" marginLeft={3}>
      <Box
        flexDirection="row"
        onClick={() => setExpanded(v => !v)}
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
      {show
        ? output.files.map(file => (
            <FileRow
              key={file.relPath}
              relPath={file.relPath}
              sites={file.sites}
            />
          ))
        : null}
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
