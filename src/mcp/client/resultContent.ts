// One MCP content item → the message blocks the model receives.
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  audioPrefix,
  blobNotSavedText,
  resourceLinkText,
  resourcePrefix,
} from 'src/mcp/client/modelTexts.js'
import { toolResultFile } from 'src/mcp/client/resultFiles.js'
import {
  getBinaryBlobSavedMessage,
  persistBinaryContent,
} from 'src/mcp/mcpOutputStorage.js'
import { recursivelySanitizeUnicode } from 'src/shared/data/sanitization.js'
import { maybeResizeAndDownsampleImageBuffer } from 'src/terminal/image/imageResizer.js'

type ContentItem = PromptMessage['content']
type ImageMediaType = Base64ImageSource['media_type']

const API_IMAGE_MEDIA_TYPES: ReadonlyMap<string, ImageMediaType> = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
])

/** The resizer speaks formats (`png`), the API speaks media types (`image/png`). */
function mediaTypeOfFormat(format: string): ImageMediaType {
  const normalized = format === 'jpg' ? 'jpeg' : format
  return API_IMAGE_MEDIA_TYPES.get(`image/${normalized}`) ?? 'image/png'
}

function formatOfMediaType(mimeType: string): string {
  return mimeType.split('/')[1] ?? 'png'
}

async function imageBlock(base64: string, mimeType: string): Promise<ImageBlockParam> {
  const bytes = Buffer.from(base64, 'base64')
  const fitted = await maybeResizeAndDownsampleImageBuffer(bytes, bytes.length, formatOfMediaType(mimeType))
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaTypeOfFormat(fitted.mediaType),
      data: fitted.buffer.toString('base64'),
    },
  }
}

function textBlock(text: string): ContentBlockParam {
  return { type: 'text', text: recursivelySanitizeUnicode(text) }
}

async function savedBlobBlock(
  base64: string,
  mimeType: string | undefined,
  serverName: string,
  prefix: string,
): Promise<ContentBlockParam> {
  const bytes = Buffer.from(base64, 'base64')
  const saved = await persistBinaryContent(bytes, mimeType, toolResultFile({ kind: 'blob', server: serverName }))
  if ('error' in saved) return textBlock(blobNotSavedText(prefix, mimeType, bytes.length, saved.error))
  return textBlock(getBinaryBlobSavedMessage(saved.filepath, mimeType, saved.size, prefix))
}

async function resourceBlocks(
  item: Extract<ContentItem, { type: 'resource' }>,
  serverName: string,
): Promise<ContentBlockParam[]> {
  const { resource } = item
  const prefix = resourcePrefix(serverName, resource.uri)
  if ('text' in resource && typeof resource.text === 'string') return [textBlock(prefix + resource.text)]
  if (!('blob' in resource) || typeof resource.blob !== 'string') return []
  const mimeType = resource.mimeType
  if (mimeType !== undefined && API_IMAGE_MEDIA_TYPES.has(mimeType)) {
    return [textBlock(prefix), await imageBlock(resource.blob, mimeType)]
  }
  return [await savedBlobBlock(resource.blob, mimeType, serverName, prefix)]
}

export async function contentItemToBlocks(
  item: ContentItem,
  serverName: string,
): Promise<ContentBlockParam[]> {
  switch (item.type) {
    case 'text':
      return [textBlock(item.text)]
    case 'image':
      return [await imageBlock(item.data, item.mimeType)]
    case 'audio':
      return [await savedBlobBlock(item.data, item.mimeType, serverName, audioPrefix(serverName))]
    case 'resource':
      return resourceBlocks(item, serverName)
    case 'resource_link':
      return [textBlock(resourceLinkText(item.name, item.uri, item.description))]
    default:
      return []
  }
}
