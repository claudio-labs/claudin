/**
 * Reads the end of a log that may be too large to load whole. A missing file
 * and a failed read are outcomes, not exceptions: the caller reports either
 * one and carries on.
 */
import { type FileHandle, open } from 'fs/promises'

import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'

export type TailLimits = {
  /** The most bytes read, counted back from the end of the file. */
  readonly maxBytes: number
  /** The most lines returned from what was read. */
  readonly maxLines: number
}

export type LogTail =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | {
      readonly kind: 'read'
      readonly sizeBytes: number
      readonly lines: readonly string[]
    }

export async function readLogTail(
  path: string,
  limits: TailLimits,
): Promise<LogTail> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return isENOENT(error)
      ? { kind: 'missing' }
      : { kind: 'unreadable', reason: errorMessage(error) }
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - limits.maxBytes)
    const window = await readToEnd(handle, start, limits.maxBytes)
    return {
      kind: 'read',
      sizeBytes: size,
      lines: lastLines(window, limits.maxLines, start > 0),
    }
  } catch (error) {
    return { kind: 'unreadable', reason: errorMessage(error) }
  } finally {
    await handle.close().catch((error: unknown) => {
      logForDebugging(`[logTail] could not close ${path}: ${errorMessage(error)}`)
    })
  }
}

/**
 * The last `count` lines of `text`. A trailing newline ends the last line
 * rather than starting an empty one. When `text` begins partway through a
 * line, that fragment is dropped, unless it is all there is.
 */
export function lastLines(
  text: string,
  count: number,
  startsMidLine: boolean,
): string[] {
  if (text === '' || count <= 0) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (startsMidLine && lines.length > 1) lines.shift()
  return lines.slice(-count)
}

/**
 * Reads from `start` until the end of the file or `maxBytes`. Given any room
 * at all, it issues at least one read, so a path that cannot be read as a
 * file (a directory) fails here with the system's reason even when it
 * reports a size of zero.
 */
async function readToEnd(
  handle: FileHandle,
  start: number,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.alloc(maxBytes)
  let filled = 0
  while (filled < maxBytes) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      maxBytes - filled,
      start + filled,
    )
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.toString('utf8', 0, filled)
}
