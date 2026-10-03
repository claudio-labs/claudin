/**
 * Reads the content of a stored message without trusting its shape: a
 * transcript on disk may come from any version, or from a hand-edited export.
 */
import type { TranscriptMessage } from 'src/shared/types/logs.js'

export type ContentBlock = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `message.content` of a user or assistant line: a string, a block list, or anything else as written. */
export function contentOf(message: TranscriptMessage): unknown {
  const inner: unknown = 'message' in message ? message.message : undefined
  return isRecord(inner) ? inner.content : undefined
}

/** The blocks of a list content; none for a string or a missing content. */
export function contentBlocks(message: TranscriptMessage): ContentBlock[] {
  const content = contentOf(message)
  return Array.isArray(content) ? content.filter(isRecord) : []
}

export function isMetaMessage(message: TranscriptMessage): boolean {
  return 'isMeta' in message && message.isMeta === true
}

export function callsTool(message: TranscriptMessage, toolUseId: string): boolean {
  return contentBlocks(message).some(block => block.type === 'tool_use' && block.id === toolUseId)
}

export function answersTool(message: TranscriptMessage, toolUseId: string): boolean {
  return contentBlocks(message).some(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
}
