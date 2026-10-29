import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import type { Message } from 'src/shared/types/message.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from 'src/tools/SyntheticOutputTool/SyntheticOutputTool.js'

/**
 * Whether a stream that ended without throwing actually delivered a reply.
 * `queryModel` (streaming.ts) asks this after the event loop exits; an
 * `incomplete` verdict throws, and the catch there retries once in streaming
 * mode, then falls back to a non-streaming request. query.ts tombstones
 * whatever the failed attempt had already yielded, so a retry never shows
 * twice.
 *
 * Runs for every provider: each shim hands this the same Anthropic events.
 *
 * CLAUDIN_THINKING_ONLY_RETRY=0 accepts a reply that only thought (see below)
 * as complete again.
 */
export type StreamEndFacts = {
  /** A message_start arrived. */
  sawMessageStart: boolean
  /** The type of every content block that completed (content_block_stop). */
  blockTypes: readonly string[]
  /** The last message_delta's stop_reason, or null when none arrived. */
  stopReason: string | null
  /** The request ends with the result of a StructuredOutput call: the model
   * has answered, and a reply with no text is the expected one. */
  answersStructuredOutput: boolean
}

export type StreamEnd =
  | { kind: 'complete' }
  | { kind: 'incomplete'; reason: 'no-message-start' | 'no-content' | 'thinking-only' }

const THINKING_BLOCK_TYPES: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])

export function classifyStreamEnd(facts: StreamEndFacts): StreamEnd {
  // A proxy that answered 200 with a body that is not SSE.
  if (!facts.sawMessageStart) {
    return { kind: 'incomplete', reason: 'no-message-start' }
  }
  // message_start, then the connection closed before any block completed and
  // before a stop_reason. No blocks WITH a stop_reason is a legitimate empty
  // reply: with --json-schema the model calls StructuredOutput on turn 1 and
  // answers end_turn with no content on turn 2.
  if (facts.blockTypes.length === 0 && !facts.stopReason) {
    return { kind: 'incomplete', reason: 'no-content' }
  }
  // The model thought and then ended the turn without a word or a tool call,
  // leaving the user nothing to read. gemini-cli retries the same reply
  // (THINKING_ONLY_RESPONSE). Only on end_turn: a max_tokens stop is the
  // output-limit recovery's to handle.
  if (
    facts.stopReason === 'end_turn' &&
    !facts.answersStructuredOutput &&
    facts.blockTypes.length > 0 &&
    facts.blockTypes.every(type => THINKING_BLOCK_TYPES.has(type)) &&
    !isEnvDefinedFalsy(process.env.CLAUDIN_THINKING_ONLY_RETRY)
  ) {
    return { kind: 'incomplete', reason: 'thinking-only' }
  }
  return { kind: 'complete' }
}

/** Whether the last assistant turn in the request called StructuredOutput. */
export function endsWithStructuredOutputCall(messages: readonly Message[]): boolean {
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (lastAssistant?.type !== 'assistant') return false
  const content = lastAssistant.message.content
  return (
    Array.isArray(content) &&
    content.some(
      block => block.type === 'tool_use' && block.name === SYNTHETIC_OUTPUT_TOOL_NAME,
    )
  )
}
