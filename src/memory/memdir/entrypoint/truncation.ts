import { formatFileSize } from 'src/shared/text/format.js'
import {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/entrypoint/limits.js'

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

type Measurement = Omit<EntrypointTruncation, 'content'>

const NEWLINE_BYTE = 0x0a
const UTF8_CONTINUATION_MASK = 0xc0
const UTF8_CONTINUATION_TAG = 0x80
const ADVISED_ENTRY_CHARS = 200

/**
 * The index as the model receives it: trimmed and, over either cap, cut and
 * followed by a warning. The counts and flags describe the trimmed input, so a
 * caller can tell how much was lost even when the line cut alone fits.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const text = raw.trim()
  const byteCount = Buffer.byteLength(text, 'utf8')
  const lines = text.split('\n')
  const measured: Measurement = {
    lineCount: lines.length,
    byteCount,
    wasLineTruncated: lines.length > MAX_ENTRYPOINT_LINES,
    wasByteTruncated: byteCount > MAX_ENTRYPOINT_BYTES,
  }
  if (!measured.wasLineTruncated && !measured.wasByteTruncated) {
    return { content: text, ...measured }
  }
  const lineBounded = measured.wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : text
  const body = clipToBytes(lineBounded, MAX_ENTRYPOINT_BYTES)
  return { content: `${body}\n\n${truncationWarning(measured)}`, ...measured }
}

/**
 * Cuts at the last newline within the limit, dropping it; with none, cuts at
 * the limit itself, moved back so no UTF-8 character is split.
 */
function clipToBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  const newline = bytes.lastIndexOf(NEWLINE_BYTE, limit)
  const end = newline >= 0 ? newline : characterStartAt(bytes, limit)
  return bytes.subarray(0, end).toString('utf8')
}

function characterStartAt(bytes: Buffer, index: number): number {
  let start = index
  while (
    start > 0 &&
    ((bytes[start] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_TAG
  ) {
    start--
  }
  return start
}

function truncationWarning(measured: Measurement): string {
  const size = formatFileSize(measured.byteCount)
  let reason: string
  if (measured.wasLineTruncated && measured.wasByteTruncated) {
    reason = `${measured.lineCount} lines and ${size}`
  } else if (measured.wasLineTruncated) {
    reason = `${measured.lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
  } else {
    reason = `${size} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) because its entries are too long`
  }
  // Starts with "> " so the line can never be counted as an index entry.
  return `> WARNING: ${ENTRYPOINT_NAME} is ${reason}; only part of it was loaded. Keep each entry to one line of about ${ADVISED_ENTRY_CHARS} characters at most, and move the details into topic files.`
}
