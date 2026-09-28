import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { ColorDiff } from 'src/native-ts/color-diff/index.js'
import { useSettings } from 'src/platform/useSettings.js'
import { Box, NoSelect, RawAnsi, useTheme } from 'src/terminal/ink.js'
import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js'
import { getColorModuleUnavailableReason } from 'src/vcs/diff/structured/colorDiff.js'
import { StructuredDiffFallback } from 'src/vcs/diff/structured/Fallback.js'
import { chooseDiffPath } from 'src/vcs/diff/structured/highlighted/path.js'
import { type HighlightedPicture, highlightedPicture } from 'src/vcs/diff/structured/highlighted/picture.js'
import { effectiveWidth } from 'src/vcs/diff/structured/layout/width.js'

type Props = {
  patch: StructuredPatchHunk
  dim: boolean
  filePath: string
  firstLine: string | null
  /** Handed on to the syntax renderer. */
  fileContent?: string
  width: number
  skipHighlighting?: boolean
}

/**
 * Draws one hunk: syntax-highlighted by the renderer in src/native-ts/color-diff,
 * or by the plain fallback when highlighting is off for any reason.
 */
function StructuredDiffView({
  patch,
  dim,
  filePath,
  firstLine,
  fileContent,
  width,
  skipHighlighting = false,
}: Props): React.ReactNode {
  const themeName = useTheme()[0]
  const settings = useSettings()
  const columns = effectiveWidth(width)
  const path = chooseDiffPath({
    skipHighlighting,
    highlightingDisabled: settings.syntaxHighlightingDisabled === true,
    unavailableReason: getColorModuleUnavailableReason(),
  })
  const picture =
    path === 'highlighted'
      ? highlightedPicture(
          {
            hunk: patch,
            themeName,
            width: columns,
            dim,
            filePath,
            firstLine,
            fileContent: fileContent ?? null,
            fenced: isFullscreenEnvEnabled(),
          },
          ColorDiff,
        )
      : null
  if (picture === null) return <StructuredDiffFallback patch={patch} dim={dim} width={columns} />
  return <HighlightedRows picture={picture} width={columns} />
}

function HighlightedRows({ picture, width }: { picture: HighlightedPicture; width: number }): React.ReactNode {
  if (picture.kind === 'whole') return <RawAnsi lines={picture.rows} width={width} />
  return (
    <Box flexDirection="row">
      <NoSelect fromLeftEdge flexShrink={0}>
        <RawAnsi lines={picture.gutter} width={picture.gutterWidth} />
      </NoSelect>
      <RawAnsi lines={picture.code} width={width - picture.gutterWidth} />
    </Box>
  )
}

export const StructuredDiff = React.memo(StructuredDiffView)
