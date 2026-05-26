import { feature } from 'bun:bundle'
import { readFile } from 'node:fs/promises'
import type React from 'react'
import { useEffect, useState } from 'react'
import { Text } from '../ink.js'
import {
  getInlineImageProtocol,
  type InlineImageProtocol,
} from '../ink/terminal.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { getGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  deleteKittyImage,
  MAX_CELLS as MAX_PLACEHOLDER_CELLS,
  nextImageId,
  placeholderLines,
  transmitKittyImage,
} from '../utils/kittyImageProtocol.js'

type Props = {
  /** Absolute path to the image file on disk. */
  path: string
  /** Fallback rendered when inline protocol unavailable or image load fails. */
  fallback: React.ReactNode
  /** Maximum height in terminal cells. */
  maxRows?: number
  /** Maximum width in terminal cells. */
  maxCols?: number
}

// Approximate terminal cell pixel size used to convert image pixels into cells
// while preserving aspect ratio. Real cell size varies by font and DPI; this
// is a pragmatic default that matches typical monospace fonts on modern
// terminals. A wrong assumption shifts aspect ratio slightly but never breaks
// layout (we still clamp to maxRows/maxCols).
const CELL_W = 10
const CELL_H = 20

/**
 * Returns true when the user has not disabled inline rendering AND the
 * `INLINE_IMAGES` build flag is on (the flag is preprocessed to a boolean
 * literal during build, so the dead branch is stripped from the bundle).
 */
function inlineEnabled(): boolean {
  if (!feature('INLINE_IMAGES')) return false
  const mode = getGlobalConfig().inlineImagesMode ?? 'auto'
  return mode !== 'disable'
}

/**
 * Compute the (rows, cols) footprint for an image with given pixel dims,
 * clamped to (maxRows × maxCols) and respecting the terminal viewport
 * minus a safety margin for surrounding chrome.
 */
function computeCellBox(
  pixelW: number,
  pixelH: number,
  maxRows: number,
  maxCols: number,
): { rows: number; cols: number } {
  const term = process.stdout.getWindowSize?.() ?? [80, 24]
  const termCols = Math.max(1, term[0])
  const termRows = Math.max(1, term[1])

  const boundCols = Math.max(
    1,
    Math.min(maxCols, termCols, MAX_PLACEHOLDER_CELLS),
  )
  const boundRows = Math.max(
    1,
    Math.min(maxRows, termRows - 2, MAX_PLACEHOLDER_CELLS),
  )

  const aspect = pixelW / pixelH // > 1 = wide, < 1 = tall
  const cellAspect = CELL_W / CELL_H

  // Try fitting by width first.
  let cols = boundCols
  let rows = Math.round((cols / aspect) * cellAspect)
  if (rows > boundRows) {
    rows = boundRows
    cols = Math.round(rows * aspect * (CELL_H / CELL_W))
  }
  return {
    rows: Math.max(1, Math.min(rows, boundRows)),
    cols: Math.max(1, Math.min(cols, boundCols)),
  }
}

export function InlineImage({
  path,
  fallback,
  maxRows = 10,
  maxCols = 80,
}: Props): React.ReactElement {
  // Snapshot detection at mount: XTVERSION may arrive between renders, but
  // flipping protocol mid-life would shift the slot below other content and
  // break the layout. Re-mount (new path) re-evaluates.
  const [protocol] = useState<InlineImageProtocol | null>(() =>
    inlineEnabled() ? getInlineImageProtocol() : null,
  )
  const [lines, setLines] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (protocol !== 'kitty') return

    let cancelled = false
    let allocatedId: number | null = null
    void (async () => {
      try {
        const sharp = await getImageProcessor()
        const fileBuf = await readFile(path)
        const metadata = await sharp(fileBuf).metadata()
        const pixelW = metadata.width ?? 1
        const pixelH = metadata.height ?? 1
        const { rows, cols } = computeCellBox(pixelW, pixelH, maxRows, maxCols)

        const targetPxW = cols * CELL_W
        const targetPxH = rows * CELL_H
        const pngBuf = await sharp(fileBuf)
          .resize(targetPxW, targetPxH, { fit: 'inside' })
          .png()
          .toBuffer()

        if (cancelled) return

        const imageId = nextImageId()
        allocatedId = imageId
        // Transmit phase: writes directly to stdout, outside the Ink frame.
        // The APC payload is invisible to the cell grid — Kitty buffers
        // the bytes and only emits pixels when the matching placeholder
        // is later drawn through Ink's normal render. We accept this
        // small race window over a more invasive Ink writer integration:
        // worst case is a one-frame flicker on the very first paint of
        // an image during streaming, never persistent corruption.
        process.stdout.write(transmitKittyImage(pngBuf, imageId))

        setLines(placeholderLines(imageId, rows, cols))
      } catch (e) {
        if (!cancelled) {
          logError(e)
          setFailed(true)
        }
      }
    })()

    return () => {
      cancelled = true
      // Free Kitty's image buffer for this slot. Without this the
      // terminal accumulates every image across a long session even
      // though our React tree has unmounted them.
      if (allocatedId !== null) {
        try {
          process.stdout.write(deleteKittyImage(allocatedId))
        } catch {
          // best-effort; stdout may be closed during shutdown
        }
      }
    }
  }, [path, protocol, maxRows, maxCols])

  if (protocol !== 'kitty' || failed) {
    return <>{fallback}</>
  }
  if (lines === null) {
    // First paint: show the fallback so the user sees something
    // immediately. Once sharp finishes, the state flips to lines and the
    // placeholders take over. The slot grows/shrinks naturally — there is
    // no manual cursor positioning.
    return <>{fallback}</>
  }
  return <Text>{lines.join('\n')}</Text>
}
