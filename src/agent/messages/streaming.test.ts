/**
 * Characterization tests for streaming bucket of src/agent/messages/messages.ts.
 * See normalize.test.ts header for context (ROADMAP 11a).
 *
 * Coverage: handleMessageFromStream against a synthetic stream that mixes
 * text deltas, tool_use deltas, thinking deltas, and stop events. Asserts on
 * the side-effect callbacks (no return value), capturing the call order.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { handleMessageFromStream } from 'src/agent/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

type Recorder = {
  messages: any[]
  lengthDeltas: string[]
  modes: string[]
  toolUseSnapshots: any[][]
  streamingThinking: any[]
  apiMetrics: any[]
  streamingText: (string | null)[]
}

function makeRecorder(): Recorder & {
  onMessage: any
  onUpdateLength: any
  onSetStreamMode: any
  onStreamingToolUses: any
  onStreamingThinking: any
  onApiMetrics: any
  onStreamingText: any
} {
  const r: Recorder = {
    messages: [],
    lengthDeltas: [],
    modes: [],
    toolUseSnapshots: [],
    streamingThinking: [],
    apiMetrics: [],
    streamingText: [],
  }
  let toolUses: any[] = []
  let streamingText: string | null = null
  return {
    ...r,
    onMessage: (m: any) => r.messages.push(m),
    onUpdateLength: (s: string) => r.lengthDeltas.push(s),
    onSetStreamMode: (m: string) => r.modes.push(m),
    onStreamingToolUses: (f: (s: any[]) => any[]) => {
      toolUses = f(toolUses)
      r.toolUseSnapshots.push(JSON.parse(JSON.stringify(toolUses)))
    },
    onStreamingThinking: (f: (curr: any) => any) => {
      const next = f(null)
      r.streamingThinking.push(next)
    },
    onApiMetrics: (m: any) => r.apiMetrics.push(m),
    onStreamingText: (f: (curr: string | null) => string | null) => {
      streamingText = f(streamingText)
      r.streamingText.push(streamingText)
    },
  }
}

function streamEvent(event: any, extra: object = {}) {
  return { type: 'stream_event' as const, event, ...extra }
}

describe('handleMessageFromStream', () => {
  test('text content block start + delta updates length and streaming text', () => {
    const r = makeRecorder()
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    expect(r.modes).toEqual(['responding'])
    expect(r.lengthDeltas).toEqual(['hello'])
    expect(r.streamingText.at(-1)).toBe('hello')
  })

  test('tool_use block: start pushes streamingToolUse, delta appends partial json', () => {
    const r = makeRecorder()
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: {} },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    expect(r.modes).toEqual(['tool-input'])
    expect(r.toolUseSnapshots.at(-1)?.[0]).toMatchObject({
      index: 1,
      contentBlock: { id: 'toolu_a', name: 'Bash' },
      unparsedToolInput: '{"cmd":"ls"}',
    })
    expect(r.lengthDeltas).toEqual(['{"cmd":"ls"}'])
  })

  test('input_json_delta preserves element order and contentBlock identity', () => {
    // Messages' memo comparator bails per-delta only when contentBlocks
    // match positionally — reordering (the old move-to-end update) re-ran
    // the full message-transform pipeline on every frame with 2+ parallel
    // streaming tool uses.
    let toolUses: any[] = []
    const onStreamingToolUses = (f: (s: any[]) => any[]) => {
      toolUses = f(toolUses)
    }
    const noop = () => {}
    for (const [index, id] of [
      [0, 'toolu_a'],
      [1, 'toolu_b'],
    ] as const) {
      handleMessageFromStream(
        streamEvent({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id, name: 'Bash', input: {} },
        }) as any,
        noop,
        noop,
        noop,
        onStreamingToolUses,
      )
    }
    const blocksBefore = toolUses.map(t => t.contentBlock)
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
      }) as any,
      noop,
      noop,
      noop,
      onStreamingToolUses,
    )
    // First element updated in place — still first, same contentBlock refs.
    expect(toolUses.map(t => t.contentBlock.id)).toEqual([
      'toolu_a',
      'toolu_b',
    ])
    expect(toolUses[0].unparsedToolInput).toBe('{"cmd":')
    expect(toolUses[1].unparsedToolInput).toBe('')
    expect(toolUses.map(t => t.contentBlock)).toEqual(blocksBefore)
    expect(toolUses[0].contentBlock).toBe(blocksBefore[0])
    expect(toolUses[1].contentBlock).toBe(blocksBefore[1])
  })

  test('thinking_delta accumulates length without modifying streaming text', () => {
    const r = makeRecorder()
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    expect(r.modes).toEqual(['thinking'])
    expect(r.lengthDeltas).toEqual(['pondering'])
  })

  test('message_stop switches to tool-use mode and clears tool uses', () => {
    const r = makeRecorder()
    // Seed a tool use.
    handleMessageFromStream(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: {} },
      }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    handleMessageFromStream(
      streamEvent({ type: 'message_stop' }) as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    expect(r.modes.at(-1)).toBe('tool-use')
    expect(r.toolUseSnapshots.at(-1)).toEqual([])
  })

  test('non-stream message (assistant) forwards via onMessage and clears streaming text', () => {
    const r = makeRecorder()
    const asst = {
      type: 'assistant' as const,
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'done', signature: 'sig' }],
      },
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-05-17T12:00:00.000Z',
    }
    handleMessageFromStream(
      asst as any,
      r.onMessage,
      r.onUpdateLength,
      r.onSetStreamMode,
      r.onStreamingToolUses,
      undefined,
      r.onStreamingThinking,
      r.onApiMetrics,
      r.onStreamingText,
    )
    expect(r.messages).toEqual([asst])
    expect(r.streamingText.at(-1)).toBeNull()
    expect(r.streamingThinking.at(-1)).toMatchObject({
      thinking: 'done',
      isStreaming: false,
    })
  })
})
