/**
 * Images pasted into the plan dialog's feedback field. They travel only with
 * a refusal: an approval carries typed feedback alone (finding 5, kept).
 */
import type { Base64ImageSource, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from 'src/platform/config/config.js'
import type { ImageDimensions } from 'src/terminal/image/imageResizer.js'
import { maybeResizeAndDownsampleImageBlock } from 'src/terminal/image/imageResizer.js'
import { cacheImagePath, storeImage } from 'src/terminal/image/imageStore.js'
import { logError } from 'src/shared/log.js'

export type PastedImages = {
  pasted: Record<number, PastedContent>
  addImage: (base64: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void
  removeImage: (id: number) => void
}

export function usePastedImages(): PastedImages {
  const [pasted, setPasted] = useState<Record<number, PastedContent>>({})
  const lastId = useRef(0)

  const addImage = useCallback<PastedImages['addImage']>((base64, mediaType, filename, dimensions, sourcePath) => {
    lastId.current += 1
    const image: PastedContent = {
      id: lastId.current,
      type: 'image',
      content: base64,
      mediaType: mediaType ?? 'image/png',
      filename: filename ?? 'Pasted image',
      dimensions,
      sourcePath,
    }
    cacheImagePath(image)
    storeImage(image).catch(logError)
    setPasted(previous => ({ ...previous, [image.id]: image }))
  }, [])

  const removeImage = useCallback((id: number) => {
    setPasted(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => Number(key) !== id)))
  }, [])

  return { pasted, addImage, removeImage }
}

async function toImageBlock(image: PastedContent): Promise<ImageBlockParam> {
  const block: ImageBlockParam = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: (image.mediaType ?? 'image/png') as Base64ImageSource['media_type'],
      data: image.content,
    },
  }
  const { block: resized } = await maybeResizeAndDownsampleImageBlock(block)
  return resized
}

/** The pasted images as message blocks, resized as usual; undefined when there are none. */
export async function imageBlocksOf(pasted: Record<number, PastedContent>): Promise<ImageBlockParam[] | undefined> {
  const images = Object.values(pasted).filter(content => content.type === 'image')
  if (images.length === 0) return undefined
  return Promise.all(images.map(toImageBlock))
}
