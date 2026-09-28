import { open } from 'fs/promises'
import {
  type TranscriptForLoad,
  TranscriptLoadAssembler,
} from 'src/sessions/sessionStoragePortable/loadAssembler.js'

/** Transcripts larger than this are loaded from their last compact boundary on. */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

const READ_SIZE = 1024 * 1024

/**
 * Reads the first `fileSize` bytes of a transcript (fewer when the file is
 * shorter) into what resume loads. Rejects when the file cannot be opened.
 */
export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<TranscriptForLoad> {
  const assembler = new TranscriptLoadAssembler(fileSize)
  const file = await open(filePath, 'r')
  try {
    const chunk = Buffer.allocUnsafe(Math.min(READ_SIZE, Math.max(fileSize, 1)))
    let position = 0
    while (position < fileSize) {
      const length = Math.min(chunk.length, fileSize - position)
      const { bytesRead } = await file.read(chunk, 0, length, position)
      if (bytesRead === 0) break
      assembler.push(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await file.close()
  }
  return assembler.finish()
}
