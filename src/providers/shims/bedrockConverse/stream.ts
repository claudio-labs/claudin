/**
 * Bedrock ConverseStream events → Anthropic stream events, and the whole
 * message they add up to.
 *
 * The SDK hands the stream over already deframed, one member per event:
 *   messageStart → message_start (the usage comes at the end, in `metadata`)
 *   contentBlockStart.start.toolUse → a tool_use block
 *   contentBlockDelta.delta.text / .toolUse.input / .reasoningContent → the
 *     block opened lazily by its first delta (text and reasoning have no start)
 *   contentBlockStop → content_block_stop
 *   messageStop.stopReason, then metadata.usage → message_delta, message_stop
 * Converse numbers its blocks itself; they are renumbered in the order they
 * appear. `inputTokens` excludes cache reads and writes, as Anthropic's
 * `input_tokens` does. An exception frame is thrown by the SDK itself
 * (client.ts turns it into an API error).
 */
import type { AnthropicStreamEvent } from 'src/providers/shims/codexShim.js'

type Event = Record<string, any>
type OpenBlock = { index: number; kind: 'text' | 'tool_use' | 'thinking' }

const STOP_REASONS: Record<string, 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  // A guardrail or content filter ends the turn; there is nothing to resume.
  guardrail_intervened: 'end_turn',
  content_filtered: 'end_turn',
}

export function converseUsage(usage: Event | undefined): Record<string, number> {
  return {
    input_tokens: Number(usage?.inputTokens ?? 0),
    output_tokens: Number(usage?.outputTokens ?? 0),
    cache_read_input_tokens: Number(usage?.cacheReadInputTokens ?? 0),
    cache_creation_input_tokens: Number(usage?.cacheWriteInputTokens ?? 0),
  }
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

export async function* converseStreamToAnthropic(
  stream: AsyncIterable<Event>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: makeMessageId(),
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: converseUsage(undefined),
    },
  }

  const open = new Map<number, OpenBlock>()
  let next = 0
  let stopReason: string | undefined
  let usage: Event | undefined
  let sawToolUse = false

  function* start(at: number, kind: OpenBlock['kind'], block: Record<string, unknown>): Generator<AnthropicStreamEvent> {
    const index = next++
    open.set(at, { index, kind })
    yield { type: 'content_block_start', index, content_block: block }
  }

  function* stop(at: number): Generator<AnthropicStreamEvent> {
    const block = open.get(at)
    if (!block) return
    open.delete(at)
    yield { type: 'content_block_stop', index: block.index }
  }

  for await (const event of stream) {
    if (event.contentBlockStart) {
      const at = Number(event.contentBlockStart.contentBlockIndex ?? 0)
      const toolUse = event.contentBlockStart.start?.toolUse
      if (toolUse) {
        sawToolUse = true
        yield* start(at, 'tool_use', { type: 'tool_use', id: String(toolUse.toolUseId), name: String(toolUse.name), input: {} })
      }
      continue
    }

    if (event.contentBlockDelta) {
      const at = Number(event.contentBlockDelta.contentBlockIndex ?? 0)
      const delta = event.contentBlockDelta.delta ?? {}
      if (typeof delta.text === 'string') {
        if (!open.has(at)) yield* start(at, 'text', { type: 'text', text: '' })
        yield { type: 'content_block_delta', index: open.get(at)!.index, delta: { type: 'text_delta', text: delta.text } }
      } else if (delta.toolUse) {
        const block = open.get(at)
        if (block?.kind === 'tool_use' && typeof delta.toolUse.input === 'string') {
          yield { type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: delta.toolUse.input } }
        }
      } else if (delta.reasoningContent) {
        if (!open.has(at)) yield* start(at, 'thinking', { type: 'thinking', thinking: '', signature: '' })
        const index = open.get(at)!.index
        const reasoning = delta.reasoningContent
        if (typeof reasoning.text === 'string') {
          yield { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning.text } }
        }
        if (typeof reasoning.signature === 'string') {
          yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: reasoning.signature } }
        }
      }
      continue
    }

    if (event.contentBlockStop) {
      yield* stop(Number(event.contentBlockStop.contentBlockIndex ?? 0))
      continue
    }

    if (event.messageStop) {
      stopReason = event.messageStop.stopReason
      continue
    }

    if (event.metadata) {
      usage = event.metadata.usage
    }
  }

  for (const at of [...open.keys()]) yield* stop(at)
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: STOP_REASONS[String(stopReason)] ?? (sawToolUse ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
    },
    usage: converseUsage(usage),
  }
  yield { type: 'message_stop' }
}

/** The whole message a stream of Anthropic events adds up to, for a non-streaming caller. */
export async function collectMessage(events: AsyncIterable<AnthropicStreamEvent>): Promise<Record<string, unknown>> {
  let message: Record<string, any> = {}
  const content: Array<Record<string, any>> = []
  const json = new Map<number, string>()
  for await (const raw of events) {
    const event = raw as Record<string, any>
    switch (event.type) {
      case 'message_start':
        message = { ...event.message }
        break
      case 'content_block_start':
        content[event.index] = { ...event.content_block }
        break
      case 'content_block_delta': {
        const block = content[event.index]!
        const delta = event.delta
        if (delta.type === 'text_delta') block.text += delta.text
        else if (delta.type === 'thinking_delta') block.thinking += delta.thinking
        else if (delta.type === 'signature_delta') block.signature += delta.signature
        else if (delta.type === 'input_json_delta') json.set(event.index, (json.get(event.index) ?? '') + delta.partial_json)
        break
      }
      case 'content_block_stop':
        if (json.has(event.index)) {
          const text = json.get(event.index)!
          content[event.index]!.input = text ? JSON.parse(text) : {}
        }
        break
      case 'message_delta':
        message.stop_reason = event.delta.stop_reason
        message.stop_sequence = event.delta.stop_sequence
        message.usage = event.usage
        break
    }
  }
  return { ...message, content }
}
