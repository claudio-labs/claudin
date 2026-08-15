import type * as React from 'react'
import { pathToFileURL } from 'node:url'
import Link from 'src/terminal/ink/components/Link.js'
import { supportsHyperlinks } from 'src/terminal/ink/supports-hyperlinks.js'
import { Box, Text } from 'src/terminal/ink.js'
import { getStoredImagePath } from 'src/terminal/image/imageStore.js'
import { InlineImage } from 'src/terminal/image/InlineImage.js'
import { MessageResponse } from 'src/agent/ui/MessageResponse.js'

type Props = {
  imageId?: number
  addMargin?: boolean
}

/**
 * Renders an image attachment in a user message.
 *
 * On Kitty-family terminals (with `inlineImagesMode != 'disable'`) we draw
 * the actual pixels via {@link InlineImage}. Everywhere else we fall back to
 * a `[Image #N]` label — clickable when the terminal supports hyperlinks.
 *
 * `addMargin` lets the caller render the image starting a new user turn
 * (no preceding text), in which case we wrap in a Box with `marginTop=1`
 * instead of stitching it to the previous message with `MessageResponse`.
 */
export function UserImageMessage({
  imageId,
  addMargin,
}: Props): React.ReactElement {
  const label = imageId ? `[Image #${imageId}]` : '[Image]'
  const imagePath = imageId ? getStoredImagePath(imageId) : null

  const linkOrLabel =
    imagePath && supportsHyperlinks() ? (
      <Link url={pathToFileURL(imagePath).href}>
        <Text>{label}</Text>
      </Link>
    ) : (
      <Text>{label}</Text>
    )

  // When we have the file on disk, try to render pixels inline; the
  // InlineImage component renders the link/label as its fallback when the
  // terminal doesn't speak the Kitty protocol or the user disabled the
  // feature, so behavior is identical for non-Kitty terminals.
  const content = imagePath ? (
    <InlineImage path={imagePath} fallback={linkOrLabel} />
  ) : (
    linkOrLabel
  )

  if (addMargin) {
    return <Box marginTop={1}>{content}</Box>
  }
  return <MessageResponse>{content}</MessageResponse>
}
