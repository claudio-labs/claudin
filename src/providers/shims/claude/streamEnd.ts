/**
 * Whether a stream that ended without throwing actually delivered a reply.
 * `queryModel` (streaming.ts) asks this after the event loop exits; an
 * `incomplete` verdict throws, and the catch there retries once in streaming
 * mode, then falls back to a non-streaming request. query.ts tombstones
 * whatever the failed attempt had already yielded, so a retry never shows
 * twice.
 *
 * Runs for every provider: each shim hands this the same Anthropic events.
 */
export type StreamEndFacts = {
  /** A message_start arrived. */
  sawMessageStart: boolean
  /** The type of every content block that completed (content_block_stop). */
  blockTypes: readonly string[]
  /** The last message_delta's stop_reason, or null when none arrived. */
  stopReason: string | null
}

export type StreamEnd =
  | { kind: 'complete' }
  | { kind: 'incomplete'; reason: 'no-message-start' | 'no-content' }

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
  return { kind: 'complete' }
}

