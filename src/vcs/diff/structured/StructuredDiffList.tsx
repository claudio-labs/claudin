import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { Box, NoSelect, Text } from 'src/terminal/ink.js'
import { StructuredDiff } from 'src/vcs/diff/structured/StructuredDiff.js'

type Props = {
  hunks: StructuredPatchHunk[]
  dim: boolean
  width: number
  filePath: string
  firstLine: string | null
  fileContent?: string
}

/** Draws the hunks of one file's patch, one under the other, with a `...` row between two of them. */
export function StructuredDiffList({ hunks, dim, width, filePath, firstLine, fileContent }: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      {hunks.map((hunk, index) => (
        // Hunks have no identity of their own: two may even start at the same line.
        <React.Fragment key={index}>
          {index > 0 && <HunkSeparator />}
          <StructuredDiff
            patch={hunk}
            dim={dim}
            width={width}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        </React.Fragment>
      ))}
    </Box>
  )
}

function HunkSeparator(): React.ReactNode {
  return (
    <NoSelect fromLeftEdge>
      <Text dimColor>...</Text>
    </NoSelect>
  )
}
