/**
 * Takes one message line back out of a transcript. The usual case only looks
 * at the end of the file, where a just-failed message is; anything further
 * back costs a whole-file rewrite, refused for very large files.
 */
import type { UUID } from 'crypto'
import { open, readFile, stat, writeFile } from 'fs/promises'
import { logForDebugging } from 'src/shared/debug.js'
import { formatFileSize } from 'src/shared/text/format.js'

export type RemovalLimits = {
  /** How far back from the end the in-place cut looks. */
  tailBytes: number
  /** The largest file the full rewrite will load. */
  maxRewriteBytes: number
}

const LF = 0x0a

/** True when the line is a JSON object whose own top-level `uuid` is `uuid` (finding 3). */
function isLineOf(line: string, uuid: UUID): boolean {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null && (parsed as { uuid?: unknown }).uuid === uuid
  } catch {
    return false
  }
}

/** Byte range of one line; `end` is past its LF when it has one. */
type LineSpan = { start: number; end: number }

function lineSpans(text: Buffer): LineSpan[] {
  const spans: LineSpan[] = []
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf(LF, start)
    const end = newline === -1 ? text.length : newline + 1
    spans.push({ start, end })
    start = end
  }
  return spans
}

/** The last line of `text` (which starts on a line boundary) that is the target's. */
function lastLineOf(text: Buffer, uuid: UUID): LineSpan | undefined {
  const needle = Buffer.from(`"uuid":"${uuid}"`)
  const spans = lineSpans(text)
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i]!
    const line = text.subarray(start, text[end - 1] === LF ? end - 1 : end)
    if (line.includes(needle) && isLineOf(line.toString('utf8'), uuid)) return spans[i]
  }
  return undefined
}

/**
 * Cuts the line in place when all of it lies in the last `tailBytes`:
 * truncate at its start, then write back the lines that followed. Every other
 * byte stays as it was. False when the line is not there.
 */
async function cutFromTail(path: string, uuid: UUID, tailBytes: number): Promise<boolean> {
  const handle = await open(path, 'r+')
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    // One byte before the window says whether the window opens on a line start.
    const from = Math.max(0, size - tailBytes - 1)
    const window = Buffer.alloc(size - from)
    await handle.read(window, 0, window.length, from)
    const skip = from === 0 ? 0 : window.indexOf(LF) + 1
    if (skip === 0 && from > 0) return false
    const whole = window.subarray(skip)
    const span = lastLineOf(whole, uuid)
    if (!span) return false
    const cutAt = from + skip + span.start
    const after = whole.subarray(span.end)
    await handle.truncate(cutAt)
    if (after.length > 0) await handle.write(after, 0, after.length, cutAt)
    return true
  } finally {
    await handle.close()
  }
}

/** Drops every line that is the target's; blank and unparsable lines stay. */
async function rewriteWithout(path: string, uuid: UUID, maxRewriteBytes: number): Promise<void> {
  const { size } = await stat(path)
  if (size > maxRewriteBytes) {
    logForDebugging(
      `Message ${uuid} left in place: the transcript is ${formatFileSize(size)}, over the ${formatFileSize(maxRewriteBytes)} rewrite limit`,
      { level: 'warn' },
    )
    return
  }
  const lines = (await readFile(path, 'utf8')).split('\n')
  const kept = lines.filter(line => !isLineOf(line, uuid))
  if (kept.length !== lines.length) await writeFile(path, kept.join('\n'))
}

/** Removes the target's line from `path`. Opening a missing file throws, and nothing is created. */
export async function removeMessageLine(path: string, uuid: UUID, limits: RemovalLimits): Promise<void> {
  if (await cutFromTail(path, uuid, limits.tailBytes)) return
  await rewriteWithout(path, uuid, limits.maxRewriteBytes)
}
