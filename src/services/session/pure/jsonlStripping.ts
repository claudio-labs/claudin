/**
 * Byte-level JSONL stripping for the on-disk `<persisted-output>` contract.
 *
 * WHY BYTE-LEVEL? `stripPersistedToolUseResultFromLine` and
 * `stripPersistedToolUseResultsFromJSONLBuffer` are called on resume to remove
 * the giant raw `toolUseResult` blobs from JSONL lines before the messages
 * are rehydrated in RAM. `JSON.parse` would allocate the full object tree
 * (including the multi-MB raw blob we are about to discard) just to
 * re-serialize it without one key — that defeats the purpose and causes OOM
 * on long sessions. The byte-level walker skips over the value without ever
 * materializing it.
 *
 * DO NOT "simplify" this to JSON.parse + delete + JSON.stringify.
 *
 * TAG DUPLICATION: `PERSISTED_OUTPUT_TAG` is also defined (as a string) in
 * `src/services/tools/toolResultStorage.ts:34` (`PERSISTED_OUTPUT_TAG`). The values
 * MUST stay in sync. Deduplication is intentionally deferred — it requires a
 * separate refactor that is out of scope for the sessionStorage split (11c).
 * TODO: consolidate against `toolResultStorage.ts` as the canonical source.
 */

import { jsonParse } from 'src/platform/slowOperations.js'

export const PERSISTED_OUTPUT_TAG = Buffer.from('<persisted-output>')
export const TOOL_USE_RESULT_KEY = Buffer.from('"toolUseResult":')

export function isJsonWhitespaceByte(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

export function skipJsonWhitespace(
  buf: Buffer,
  index: number,
  end: number,
): number {
  let i = index
  while (i < end && isJsonWhitespaceByte(buf[i])) i++
  return i
}

export function findJsonValueEnd(
  buf: Buffer,
  start: number,
  end: number,
): number {
  let i = skipJsonWhitespace(buf, start, end)
  const first = buf[i]
  if (first === undefined) return end

  if (first === 0x22) {
    i++
    let escapeNext = false
    while (i < end) {
      const byte = buf[i]!
      if (escapeNext) {
        escapeNext = false
      } else if (byte === 0x5c) {
        escapeNext = true
      } else if (byte === 0x22) {
        return i + 1
      }
      i++
    }
    return end
  }

  if (first === 0x7b || first === 0x5b) {
    const stack = [first]
    i++
    let inString = false
    let escapeNext = false
    while (i < end) {
      const byte = buf[i]!
      if (escapeNext) {
        escapeNext = false
      } else if (inString) {
        if (byte === 0x5c) escapeNext = true
        else if (byte === 0x22) inString = false
      } else if (byte === 0x22) {
        inString = true
      } else if (byte === 0x7b || byte === 0x5b) {
        stack.push(byte)
      } else if (byte === 0x7d || byte === 0x5d) {
        const open = stack.at(-1)
        if (
          (byte === 0x7d && open === 0x7b) ||
          (byte === 0x5d && open === 0x5b)
        ) {
          stack.pop()
          if (stack.length === 0) return i + 1
        }
      }
      i++
    }
    return end
  }

  while (i < end) {
    const byte = buf[i]!
    if (byte === 0x2c || byte === 0x7d) return i
    i++
  }
  return end
}

export function stripPersistedToolUseResultFromLine(line: Buffer): Buffer {
  if (
    line.indexOf(PERSISTED_OUTPUT_TAG) === -1 ||
    line.indexOf(TOOL_USE_RESULT_KEY) === -1
  ) {
    return line
  }

  let depth = 0
  let inString = false
  let escapeNext = false
  const keyLen = TOOL_USE_RESULT_KEY.length

  for (let i = 0; i <= line.length - keyLen; i++) {
    const byte = line[i]!
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (inString) {
      if (byte === 0x5c) escapeNext = true
      else if (byte === 0x22) inString = false
      continue
    }
    if (byte === 0x22) {
      if (
        depth === 1 &&
        line.compare(TOOL_USE_RESULT_KEY, 0, keyLen, i, i + keyLen) === 0
      ) {
        const valueEnd = findJsonValueEnd(line, i + keyLen, line.length)
        let removeStart = i
        let removeEnd = valueEnd
        const afterValue = skipJsonWhitespace(line, valueEnd, line.length)

        if (afterValue < line.length && line[afterValue] === 0x2c) {
          removeEnd = afterValue + 1
        } else {
          let beforeKey = i - 1
          while (beforeKey >= 0 && isJsonWhitespaceByte(line[beforeKey])) {
            beforeKey--
          }
          if (beforeKey >= 0 && line[beforeKey] === 0x2c) {
            removeStart = beforeKey
          }
        }

        return Buffer.concat([
          line.subarray(0, removeStart),
          line.subarray(removeEnd),
        ])
      }
      inString = true
      continue
    }
    if (byte === 0x7b || byte === 0x5b) depth++
    else if (byte === 0x7d || byte === 0x5d) depth--
  }

  return line
}

export function stripPersistedToolUseResultsFromJSONLBuffer(
  buf: Buffer,
): Buffer {
  if (
    buf.indexOf(PERSISTED_OUTPUT_TAG) === -1 ||
    buf.indexOf(TOOL_USE_RESULT_KEY) === -1
  ) {
    return buf
  }

  const NEWLINE = 0x0a
  const chunks: Buffer[] = []
  let changed = false
  let start = 0

  while (start < buf.length) {
    let end = buf.indexOf(NEWLINE, start)
    let hasNewline = true
    if (end === -1) {
      end = buf.length
      hasNewline = false
    }
    const line = buf.subarray(start, end)
    const sanitized = stripPersistedToolUseResultFromLine(line)
    if (sanitized !== line) changed = true
    chunks.push(sanitized)
    if (hasNewline) chunks.push(buf.subarray(end, end + 1))
    start = end + (hasNewline ? 1 : 0)
  }

  return changed ? Buffer.concat(chunks) : buf
}

/**
 * Internal-shared: parse a JSONL buffer and invoke `visit` for each entry.
 * Used by several sessionStorage internal call sites; exported so other
 * split modules (resume/, indexing/) can consume it without re-implementing.
 */
export function forEachParsedJSONLBufferEntry<T>(
  buf: Buffer,
  visit: (entry: T) => void,
): void {
  const bufLen = buf.length
  let start = 0

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue

    try {
      visit(jsonParse(line) as T)
    } catch {
      // Skip malformed lines
    }
  }
}
