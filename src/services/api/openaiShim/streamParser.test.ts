/**
 * End-to-end streaming tests for XML tool-call recovery in openaiStreamToAnthropic.
 *
 * Drives synthetic OpenAI SSE frames through the generator and asserts on the
 * Anthropic-format events it yields — no network, no ink imports.
 */

import { describe, expect, test } from 'bun:test'

import { openaiStreamToAnthropic } from './streamParser.js'
import type { AnthropicStreamEvent } from 'src/services/api/codexShim.js'

function sseResponse(dataObjects: Array<Record<string, unknown>>): Response {
  const body = dataObjects.map(o => `data: ${JSON.stringify(o)}\n`).join('') + 'data: [DONE]\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream)
}

function contentChunk(text: string): Record<string, unknown> {
  return { choices: [{ delta: { content: text } }] }
}

function finishChunk(reason: string): Record<string, unknown> {
  return { choices: [{ delta: {}, finish_reason: reason }] }
}

async function collect(
  chunks: Array<Record<string, unknown>>,
  opts: { model?: string; toolNames?: Set<string> } = {},
): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []
  for await (const ev of openaiStreamToAnthropic(
    sseResponse(chunks),
    opts.model ?? 'glm-4.5',
    undefined,
    undefined,
    opts.toolNames,
  )) {
    events.push(ev)
  }
  return events
}

function visibleText(events: AnthropicStreamEvent[]): string {
  return events
    .filter(e => e.type === 'content_block_delta' && (e as any).delta?.type === 'text_delta')
    .map(e => (e as any).delta.text)
    .join('')
}

function toolUses(events: AnthropicStreamEvent[]): Array<{ name: string; input: unknown }> {
  const starts = events.filter(
    e => e.type === 'content_block_start' && (e as any).content_block?.type === 'tool_use',
  )
  return starts.map(s => {
    const idx = (s as any).index
    const argEv = events.find(
      e =>
        e.type === 'content_block_delta' &&
        (e as any).index === idx &&
        (e as any).delta?.type === 'input_json_delta',
    )
    return {
      name: (s as any).content_block.name,
      input: argEv ? JSON.parse((argEv as any).delta.partial_json) : {},
    }
  })
}

function stopReason(events: AnthropicStreamEvent[]): string | null {
  const md = events.find(e => e.type === 'message_delta')
  return md ? ((md as any).delta?.stop_reason ?? null) : null
}

const READ_TOOLS = new Set(['Read'])

describe('openaiStreamToAnthropic — XML tool-call recovery', () => {
  test('parses a whole-chunk XML call and rewrites stop_reason', async () => {
    const events = await collect(
      [
        contentChunk(
          '<tool_call><function=Read><parameter=file_path>/tmp/x</parameter></function></tool_call>',
        ),
        finishChunk('stop'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('')
    expect(toolUses(events)).toEqual([{ name: 'Read', input: { file_path: '/tmp/x' } }])
    expect(stopReason(events)).toBe('tool_use')
  })

  test('never leaks raw XML when the opener is split across deltas', async () => {
    const events = await collect(
      [
        contentChunk('here <tool_'),
        contentChunk('call><function=Read><parameter=file_path>/x</parameter></function></tool_call>'),
        finishChunk('stop'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('here ')
    expect(visibleText(events)).not.toContain('<tool_call>')
    expect(toolUses(events)).toEqual([{ name: 'Read', input: { file_path: '/x' } }])
    expect(stopReason(events)).toBe('tool_use')
  })

  test('rewrites even a length finish_reason when a complete call parsed', async () => {
    const events = await collect(
      [
        contentChunk('<tool_call><function=Read><parameter=file_path>/x</parameter></function></tool_call>'),
        finishChunk('length'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(toolUses(events)).toHaveLength(1)
    expect(stopReason(events)).toBe('tool_use')
  })

  test('unknown tool name is a false positive → emitted verbatim, stop unchanged', async () => {
    const xml = '<tool_call><function=Nope><parameter=x>1</parameter></function></tool_call>'
    const events = await collect([contentChunk(xml), finishChunk('stop')], {
      toolNames: READ_TOOLS,
    })
    expect(visibleText(events)).toBe(xml)
    expect(toolUses(events)).toHaveLength(0)
    expect(stopReason(events)).toBe('end_turn')
  })

  test('structured tool_calls after held XML flush the XML as text', async () => {
    const events = await collect(
      [
        contentChunk('<tool_call>partial'),
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Read', arguments: '{"file_path":"/y"}' } }] } }] },
        finishChunk('tool_calls'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toContain('<tool_call>partial')
    expect(toolUses(events)).toEqual([{ name: 'Read', input: { file_path: '/y' } }])
  })

  test('trailing partial opener that never completes is emitted verbatim', async () => {
    const events = await collect(
      [contentChunk('bye <tool_'), finishChunk('stop')],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('bye <tool_')
    expect(toolUses(events)).toHaveLength(0)
    expect(stopReason(events)).toBe('end_turn')
  })

  test('<think> before a real <tool_call> is stripped and the tool parsed', async () => {
    const events = await collect(
      [
        contentChunk('<think>let me read</think><tool_call><function=Read><parameter=file_path>/z</parameter></function></tool_call>'),
        finishChunk('stop'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('')
    expect(toolUses(events)).toEqual([{ name: 'Read', input: { file_path: '/z' } }])
  })

  test('kill-switch passes XML through as plain text', async () => {
    process.env.CLAUDIN_DISABLE_XML_TOOL_CALLS = '1'
    try {
      const xml = '<tool_call><function=Read><parameter=file_path>/x</parameter></function></tool_call>'
      const events = await collect([contentChunk(xml), finishChunk('stop')], {
        toolNames: READ_TOOLS,
      })
      expect(visibleText(events)).toBe(xml)
      expect(toolUses(events)).toHaveLength(0)
    } finally {
      delete process.env.CLAUDIN_DISABLE_XML_TOOL_CALLS
    }
  })

  test('no tools advertised → layer is a no-op (XML stays text)', async () => {
    const xml = '<tool_call><function=Read><parameter=file_path>/x</parameter></function></tool_call>'
    const events = await collect([contentChunk(xml), finishChunk('stop')], {})
    expect(visibleText(events)).toBe(xml)
    expect(toolUses(events)).toHaveLength(0)
  })

  test('field-mapped tool args round-trip through normalizeToolArguments', async () => {
    const events = await collect(
      [
        contentChunk('<tool_call><function=Bash><parameter=command>ls -la</parameter></function></tool_call>'),
        finishChunk('stop'),
      ],
      { toolNames: new Set(['Bash']) },
    )
    expect(toolUses(events)).toEqual([{ name: 'Bash', input: { command: 'ls -la' } }])
  })

  test('HY3 dialect only fires for the tencent/hy3 model', async () => {
    const xml =
      '<tool_call:z>Read<parameter name="file_path">/h</parameter></tool_call:z>'
    const off = await collect([contentChunk(xml), finishChunk('stop')], {
      model: 'glm-4.5',
      toolNames: READ_TOOLS,
    })
    expect(toolUses(off)).toHaveLength(0)

    const on = await collect([contentChunk(xml), finishChunk('stop')], {
      model: 'tencent/hy3',
      toolNames: READ_TOOLS,
    })
    expect(toolUses(on)).toEqual([{ name: 'Read', input: { file_path: '/h' } }])
    expect(stopReason(on)).toBe('tool_use')
  })

  test('recovers buffered XML when the stream ends with no finish_reason', async () => {
    // No finishChunk — provider closes after data: [DONE].
    const events = await collect(
      [
        contentChunk('<tool_call><function=Read><parameter=file_path>/x</parameter></function></tool_call>'),
      ],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('')
    expect(toolUses(events)).toEqual([{ name: 'Read', input: { file_path: '/x' } }])
    expect(stopReason(events)).toBe('tool_use')
  })

  test('emits held partial-opener verbatim when stream ends with no finish_reason', async () => {
    const events = await collect([contentChunk('hi <tool_')], { toolNames: READ_TOOLS })
    expect(visibleText(events)).toBe('hi <tool_')
    expect(toolUses(events)).toHaveLength(0)
  })

  test('plain text with no XML streams unchanged', async () => {
    const events = await collect(
      [contentChunk('hello '), contentChunk('world'), finishChunk('stop')],
      { toolNames: READ_TOOLS },
    )
    expect(visibleText(events)).toBe('hello world')
    expect(toolUses(events)).toHaveLength(0)
    expect(stopReason(events)).toBe('end_turn')
  })
})
