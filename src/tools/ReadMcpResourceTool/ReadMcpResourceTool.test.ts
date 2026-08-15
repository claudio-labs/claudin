import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'

function ctxWithClients(mcpClients: unknown[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: { mcpClients },
  } as unknown as ToolUseContext
}

describe('ReadMcpResourceTool', () => {
  test('flags: read-only, concurrency-safe, defer', () => {
    expect(ReadMcpResourceTool.isReadOnly?.()).toBe(true)
    expect(ReadMcpResourceTool.isConcurrencySafe?.()).toBe(true)
    expect(ReadMcpResourceTool.shouldDefer).toBe(true)
  })

  test('input schema requires server and uri', () => {
    expect(ReadMcpResourceTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      ReadMcpResourceTool.inputSchema.safeParse({ server: 's' }).success,
    ).toBe(false)
    expect(
      ReadMcpResourceTool.inputSchema.safeParse({
        server: 's',
        uri: 'res://x',
      }).success,
    ).toBe(true)
  })

  test('toAutoClassifierInput joins server and uri', () => {
    expect(
      ReadMcpResourceTool.toAutoClassifierInput?.({
        server: 's',
        uri: 'res://x',
      }),
    ).toBe('s res://x')
  })

  test('call() throws when server is missing from mcpClients', async () => {
    await expect(
      ReadMcpResourceTool.call(
        { server: 'missing', uri: 'res://x' } as never,
        ctxWithClients([{ name: 'other', type: 'connected' }]),
      ),
    ).rejects.toThrow(
      'Server "missing" not found. Available servers: other',
    )
  })

  test('call() throws when server is not connected', async () => {
    await expect(
      ReadMcpResourceTool.call(
        { server: 'broken', uri: 'res://x' } as never,
        ctxWithClients([
          {
            name: 'broken',
            type: 'failed',
            error: new Error('boom'),
          },
        ]),
      ),
    ).rejects.toThrow('Server "broken" is not connected')
  })

  test('call() throws when server lacks resource capability', async () => {
    await expect(
      ReadMcpResourceTool.call(
        { server: 'no-res', uri: 'res://x' } as never,
        ctxWithClients([
          {
            name: 'no-res',
            type: 'connected',
            capabilities: { tools: {} },
          },
        ]),
      ),
    ).rejects.toThrow('does not support resources')
  })

  test('mapToolResultToToolResultBlockParam serialises the output', () => {
    const block = ReadMcpResourceTool.mapToolResultToToolResultBlockParam?.(
      { contents: [{ uri: 'res://x', text: 'hi' }] },
      'u1',
    )
    expect(block?.tool_use_id).toBe('u1')
    expect(block?.content).toContain('"res://x"')
    expect(block?.content).toContain('"hi"')
  })
})
