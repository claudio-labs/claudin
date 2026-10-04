import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { MCPResultType } from 'src/mcp/client.js'
import { blobSavedText, readSavedFileText } from 'src/mcp/client/modelTexts.js'
import { isSafeFileId } from 'src/mcp/client/resultFiles.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { ensureToolResultsDir, getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'

export function getFormatDescription(
  type: MCPResultType,
  schema?: unknown,
): string {
  if (type === 'toolResult') return 'Plain text'
  const kind = type === 'structuredContent' ? 'JSON' : 'JSON array'
  return schema ? `${kind} with schema: ${String(schema)}` : kind
}

export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
): string {
  return readSavedFileText(rawOutputPath, contentLength, formatDescription, maxReadLength)
}

/** The bare media type: no parameters, no case, no surrounding space. */
function bareMediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase()
}

// A Map, not an object literal: a lookup must never reach a prototype key.
const EXTENSION_BY_MEDIA_TYPE: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['application/zip', 'zip'],
  ['application/msword', 'doc'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['text/html', 'html'],
  ['text/markdown', 'md'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
])

const FALLBACK_EXTENSION = 'bin'

export function extensionForMimeType(mimeType: string | undefined): string {
  return EXTENSION_BY_MEDIA_TYPE.get(bareMediaType(mimeType)) ?? FALLBACK_EXTENSION
}

const TEXTUAL_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
])
const TEXTUAL_SUFFIXES = ['+json', '+xml'] as const

export function isBinaryContentType(contentType: string): boolean {
  const type = bareMediaType(contentType)
  if (type === '') return false
  if (type.startsWith('text/') || type.startsWith('application/javascript')) return false
  if (TEXTUAL_MEDIA_TYPES.has(type)) return false
  return !TEXTUAL_SUFFIXES.some(suffix => type.endsWith(suffix))
}

export type PersistBinaryResult =
  | { filepath: string; size: number; ext: string }
  | { error: string }

/** Writes raw bytes to `<tool-results>/<persistId>.<ext>`, overwriting. Failures are returned, never thrown. */
export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  if (!isSafeFileId(persistId)) {
    const error = `refused to save binary content under the id "${persistId}": it must not hold a path`
    logError(new Error(error))
    return { error }
  }
  const ext = extensionForMimeType(mimeType)
  const filepath = join(getToolResultsDir(), `${persistId}.${ext}`)
  try {
    await ensureToolResultsDir()
    await writeFile(filepath, bytes)
  } catch (thrown) {
    const error = toError(thrown)
    logError(error)
    return { error: error.message }
  }
  return { filepath, size: bytes.length, ext }
}

export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  return blobSavedText(sourceDescription, filepath, mimeType, size)
}
