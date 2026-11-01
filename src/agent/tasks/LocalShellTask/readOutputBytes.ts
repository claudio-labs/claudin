// The raw bytes of a task's output file from `offset`, at most `maxBytes`.
// Monitor counts its offset in bytes on disk; reading text instead would turn
// an invalid byte into a 3-byte U+FFFD and push the offset past real output.

import { open } from 'fs/promises'
import { isENOENT } from 'src/shared/errors.js'

export async function readOutputBytes(path: string, offset: number, maxBytes: number): Promise<Buffer> {
  try {
    await using fh = await open(path, 'r')
    const size = (await fh.stat()).size
    const buffer = Buffer.alloc(Math.max(0, Math.min(size - offset, maxBytes)))
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await fh.read(buffer, filled, buffer.length - filled, offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return buffer.subarray(0, filled)
  } catch (e) {
    // The command has not written anything yet.
    if (isENOENT(e)) return Buffer.alloc(0)
    throw e
  }
}
