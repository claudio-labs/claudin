import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { ListMcpResourcesTool } from './ListMcpResourcesTool.js'

function ctxWithClients(mcpClients: unknown[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: { mcpClients },
  } as unknown as ToolUseContext
}

describe('ListMcpResourcesTool', () => {
  test('flags: read-only, concurrency-safe, defer', () => {
    expect(ListMcpResourcesTool.isReadOnly?.()).toBe(true)
    expect(ListMcpResourcesTool.isConcurrencySafe?.()).toBe(true)
    expect(ListMcpResourcesTool.shouldDefer).toBe(true)
  })

  test('userFacingName is listMcpResources', () => {
    expect(ListMcpResourcesTool.userFacingName()).toBe('listMcpResources')
  })

  test('input schema accepts empty object and optional server filter', () => {
    expect(ListMcpResourcesTool.inputSchema.safeParse({}).success).toBe(true)
    expect(
      ListMcpResourcesTool.inputSchema.safeParse({ server: 'foo' }).success,
    ).toBe(true)
    // Non-string server is rejected
    expect(
      ListMcpResourcesTool.inputSchema.safeParse({ server: 42 }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput returns the server filter or empty', () => {
    expect(
      ListMcpResourcesTool.toAutoClassifierInput?.({ server: 'foo' }),
    ).toBe('foo')
    expect(ListMcpResourcesTool.toAutoClassifierInput?.({})).toBe('')
  })

  test('call() throws when targeted server is not in mcpClients', async () => {
    await expect(
      ListMcpResourcesTool.call(
        { server: 'missing' } as never,
        ctxWithClients([{ name: 'other', type: 'connected' }]),
      ),
    ).rejects.toThrow(
      'Server "missing" not found. Available servers: other',
    )
  })

  test('call() returns [] when no MCP clients are connected', async () => {
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        { name: 'broken', type: 'failed', error: new Error('boom') },
      ]),
    )
    expect(data).toEqual([])
  })

  test('mapToolResultToToolResultBlockParam handles empty and populated results', () => {
    const map = ListMcpResourcesTool.mapToolResultToToolResultBlockParam
    expect(map).toBeDefined()
    const empty = map?.([], 'u1')
    expect(empty?.content).toContain('No resources found')

    const populated = map?.(
      [
        {
          uri: 'res://a',
          name: 'a',
          server: 's',
        },
      ],
      'u2',
    )
    expect(populated?.content).toContain('"res://a"')
    expect(populated?.content).toContain('"server"')
  })
})
