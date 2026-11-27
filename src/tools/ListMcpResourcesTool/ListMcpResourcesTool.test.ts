import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'

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

  // An `sdk` server, so ensureConnectedClient hands it back as is; the fake
  // validates each answer with the schema it is handed, as the SDK does.
  function resourceServer(name: string, answers: Record<string, unknown>) {
    return {
      name,
      type: 'connected',
      capabilities: { resources: {} },
      config: { type: 'sdk', name, scope: 'local' },
      client: {
        request: async (req: { method: string }, schema: { parse: (v: unknown) => unknown }) => {
          const answer = answers[req.method]
          if (answer instanceof Error) throw answer
          return schema.parse(answer)
        },
      },
    }
  }

  test('call() lists resources and resource templates, each with its server', async () => {
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        resourceServer('files', {
          'resources/list': { resources: [{ uri: 'file:///readme', name: 'readme' }] },
          'resources/templates/list': {
            resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'any file' }, { name: 'no template' }],
          },
        }),
      ]),
    )
    expect(data).toEqual([
      { uri: 'file:///readme', name: 'readme', server: 'files' },
      { uriTemplate: 'file:///{path}', name: 'any file', server: 'files' },
    ])
    expect(ListMcpResourcesTool.outputSchema!.safeParse(data).success).toBe(true)
  })

  test('call() treats a server without templates/list as having no templates', async () => {
    const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js')
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        resourceServer('no-templates', {
          'resources/list': { resources: [{ uri: 'res://only', name: 'only' }] },
          'resources/templates/list': new McpError(ErrorCode.MethodNotFound, 'Method not found'),
        }),
      ]),
    )
    expect(data).toEqual([{ uri: 'res://only', name: 'only', server: 'no-templates' }])
  })

  test('call() keeps the other servers when one fails its templates list', async () => {
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        resourceServer('flaky', {
          'resources/list': { resources: [] },
          'resources/templates/list': new Error('socket hang up'),
        }),
        resourceServer('steady', { 'resources/list': { resources: [{ uri: 'res://s', name: 's' }] }, 'resources/templates/list': { resourceTemplates: [] } }),
      ]),
    )
    expect(data).toEqual([{ uri: 'res://s', name: 's', server: 'steady' }])
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
