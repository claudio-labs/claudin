/**
 * Fake callModel for memory-e2e-bench.
 *
 * This module produces an AsyncGenerator that matches the shape
 * expected by src/agent/query.ts — it emits stream_event + assistant messages
 * in the order the real `queryModelWithStreaming` would, but without
 * any network IO.
 *
 * Scripted by turn: each turn in the script dictates what the fake
 * assistant "replies" with. The bench drives a session by calling
 * engine.submitMessage() N times; the fake deps.callModel pops the
 * next TurnScript entry on each call.
 *
 * Shape mirrors what src/providers/shims/claude.ts yields:
 *   - message_start stream_event (with ttftMs)
 *   - content_block_start/delta/stop events
 *   - message_delta stream_event (with stop_reason + usage)
 *   - message_stop stream_event
 *   - final APIAssistantMessage yielded via src/agent/query.ts:createAssistantMessage
 *
 * The minimal set of events src/agent/query.ts actually cares about is:
 *   - final APIAssistantMessage (consumed for tool dispatch)
 * Everything else is observability. We still emit stream_event to keep
 * the wire path realistic, but the bench will work with only the final
 * message too.
 */

import { randomUUID } from 'crypto'
import type { queryModelWithStreaming } from '../../src/providers/shims/claude.js'

// --- TurnScript DSL ---

export type TurnScript =
  | { kind: 'text'; text: string; outputTokens?: number }
  | {
      kind: 'tool_use'
      toolName: string
      input: Record<string, unknown>
      id?: string
      outputTokens?: number
    }
  | {
      kind: 'multi_tool_use'
      tools: Array<{ toolName: string; input: Record<string, unknown>; id?: string }>
      outputTokens?: number
    }
  | { kind: 'error'; message: string }

// Helpers
export function turnText(text: string, outputTokens = 50): TurnScript {
  return { kind: 'text', text, outputTokens }
}

export function turnToolUse(
  toolName: string,
  input: Record<string, unknown>,
  outputTokens = 80,
): TurnScript {
  return { kind: 'tool_use', toolName, input, outputTokens }
}

export function turnMultiToolUse(
  tools: Array<{ toolName: string; input: Record<string, unknown> }>,
  outputTokens = 120,
): TurnScript {
  return { kind: 'multi_tool_use', tools, outputTokens }
}

export function turnError(message: string): TurnScript {
  return { kind: 'error', message }
}

// --- Usage shape mirrors @anthropic-ai/sdk Usage ---

function buildUsage(
  inputTokens: number,
  outputTokens: number,
): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

// --- Content block construction ---

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }

function buildContent(turn: TurnScript): ContentBlock[] {
  switch (turn.kind) {
    case 'text':
      return [{ type: 'text', text: turn.text }]
    case 'tool_use':
      return [
        {
          type: 'tool_use',
          id: turn.id ?? `toolu_${randomUUID().slice(0, 8)}`,
          name: turn.toolName,
          input: turn.input,
        },
      ]
    case 'multi_tool_use':
      return turn.tools.map(t => ({
        type: 'tool_use' as const,
        id: t.id ?? `toolu_${randomUUID().slice(0, 8)}`,
        name: t.toolName,
        input: t.input,
      }))
    case 'error':
      return [{ type: 'text', text: `Error: ${turn.message}` }]
  }
}

// --- Factory ---

/**
 * Create a fake callModel that pops the next TurnScript on each call.
 *
 * If the script runs out, the fake continues emitting "end_turn" text
 * responses to let the caller's loop terminate naturally.
 */
export function createFakeCallModel(
  script: TurnScript[],
  opts: {
    model?: string
    onCall?: (callIndex: number, turn: TurnScript) => void
  } = {},
): typeof queryModelWithStreaming {
  const model = opts.model ?? 'claudin-fake-model'
  let callIndex = 0

  // We have to satisfy the full signature of queryModelWithStreaming.
  // We return a function whose generator produces the minimum set of
  // events the consumer (query.ts) understands.
  const fake: typeof queryModelWithStreaming = async function* fakeCallModel(
    ...args: Parameters<typeof queryModelWithStreaming>
  ): ReturnType<typeof queryModelWithStreaming> {
    const options = args[0]
    const turn: TurnScript =
      callIndex < script.length
        ? script[callIndex]!
        : { kind: 'text', text: 'done' }
    opts.onCall?.(callIndex, turn)
    callIndex++

    const content = buildContent(turn)
    const messageId = `msg_${randomUUID().slice(0, 8)}`
    const stopReason: 'end_turn' | 'tool_use' = content.some(
      b => b.type === 'tool_use',
    )
      ? 'tool_use'
      : 'end_turn'

    const inputTokens =
      typeof options === 'object' && options && 'messages' in options
        ? Math.max(
            1,
            Math.round(
              JSON.stringify((options as { messages: unknown }).messages).length / 4,
            ),
          )
        : 100
    const outputTokens = turn.kind === 'error' ? 10 : (turn.outputTokens ?? 50)
    const usage = buildUsage(inputTokens, outputTokens)

    // 1. stream_event: message_start
    yield {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
      ttftMs: 1,
    } as unknown as Awaited<
      ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
    >['value']

    // 2. Per-block stream_events (content_block_start/stop)
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: i,
          content_block:
            block.type === 'text'
              ? { type: 'text', text: '' }
              : {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: {},
                },
        },
      } as unknown as Awaited<
        ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
      >['value']

      if (block.type === 'text') {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'text_delta', text: block.text },
          },
        } as unknown as Awaited<
          ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
        >['value']
      } else {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: i,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.input),
            },
          },
        } as unknown as Awaited<
          ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
        >['value']
      }

      yield {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: i },
      } as unknown as Awaited<
        ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
      >['value']
    }

    // 3. message_delta + message_stop
    yield {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage,
      },
    } as unknown as Awaited<
      ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
    >['value']

    yield {
      type: 'stream_event',
      event: { type: 'message_stop' },
    } as unknown as Awaited<
      ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
    >['value']

    // 4. Final assistant APIAssistantMessage — this is what the consumer
    // actually dispatches on. Shape matches what query.ts expects from
    // createAssistantMessage.
    yield {
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      },
      costUSD: 0,
      durationMs: 1,
      requestId: messageId,
    } as unknown as Awaited<
      ReturnType<ReturnType<typeof queryModelWithStreaming>['next']>
    >['value']
  }
  return fake
}

/**
 * Noop autocompact — never triggers compact in bench unless explicitly
 * requested via the TurnScript (future extension).
 */
export async function fakeAutocompact(
  messages: unknown[],
): Promise<{ messages: unknown[]; wasCompacted: false }> {
  return { messages, wasCompacted: false }
}

/**
 * Identity microcompact — returns messages unchanged so QueryEngine's
 * applyStableStubs path still runs on the real data.
 */
export async function fakeMicrocompact<T>(messages: T): Promise<T> {
  return messages
}
