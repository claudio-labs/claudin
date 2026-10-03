/**
 * The messages of a transcript exported as JSON: a list of messages, or an
 * object holding one under `messages`. They are taken as given, in order.
 */
import { readFile } from 'fs/promises'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseExport(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in transcript file: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Rejects with the read error when the file cannot be read, and with a shape error when it is not a transcript. */
export async function readExportedMessages(filePath: string): Promise<TranscriptMessage[]> {
  const exported = parseExport(await readFile(filePath, 'utf8'))
  if (Array.isArray(exported)) return exported as TranscriptMessage[]
  if (isRecord(exported) && 'messages' in exported) {
    if (!Array.isArray(exported.messages)) throw new Error('Transcript messages must be an array')
    return exported.messages as TranscriptMessage[]
  }
  throw new Error('Transcript must be an array of messages or an object with a messages array')
}
