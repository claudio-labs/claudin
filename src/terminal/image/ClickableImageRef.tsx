import { pathToFileURL } from 'node:url'
import type React from 'react'
import Link from 'src/terminal/ink/components/Link.js'
import { supportsHyperlinks } from 'src/terminal/ink/supports-hyperlinks.js'
import { Text } from 'src/terminal/ink.js'
import { getStoredImagePath } from 'src/terminal/image/imageStore.js'
import type { Theme } from 'src/terminal/theme/theme.js'
import { InlineImage } from 'src/terminal/image/InlineImage.js'

type Props = {
  imageId: number
  backgroundColor?: keyof Theme
  isSelected?: boolean
}

/**
 * Renders an image reference like [Image #1].
 *
 * Layered display strategy:
 * 1. On Kitty-family terminals (and with inlineImagesMode != 'disable'),
 *    InlineImage takes over and draws the actual pixels.
 * 2. On terminals with hyperlink support, the legacy OSC 8 link is used.
 * 3. Otherwise, just the styled `[Image #N]` text label.
 *
 * Each layer falls through to the next when its prerequisite is missing,
 * so users always see something even if the image file is gone.
 */
export function ClickableImageRef({
  imageId,
  backgroundColor,
  isSelected = false,
}: Props): React.ReactElement {
  const imagePath = getStoredImagePath(imageId)
  const displayText = `[Image #${imageId}]`

  const label = (
    <Text backgroundColor={backgroundColor} inverse={isSelected}>
      {displayText}
    </Text>
  )

  const labelBold = (
    <Text
      backgroundColor={backgroundColor}
      inverse={isSelected}
      bold={isSelected}
    >
      {displayText}
    </Text>
  )

  const hyperlinkOrText =
    imagePath && supportsHyperlinks() ? (
      <Link url={pathToFileURL(imagePath).href} fallback={label}>
        {labelBold}
      </Link>
    ) : (
      label
    )

  if (!imagePath) return hyperlinkOrText

  return (
    <InlineImage
      path={imagePath}
      fallback={hyperlinkOrText}
      maxRows={6}
      maxCols={40}
    />
  )
}
