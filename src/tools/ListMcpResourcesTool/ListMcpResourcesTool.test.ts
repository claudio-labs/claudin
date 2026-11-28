import { afterEach, describe, expect, test } from 'bun:test'

import { connectRawMcpServer, type RawHandler, type RawMcpServer } from 'src/mcp/__testutils__/rawMcpServer.js'
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
  const servers: RawMcpServer[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

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

  // An `sdk` server, so ensureConnectedClient hands it back as is; a raw
  // server behind the wire filter, which checks each entry as on the wire.
  // `asked` records each request and the timeout the templates list was given.
  async function resourceServer(name: string, answers: Record<string, unknown>) {
    const handlers: Record<string, RawHandler> = {}
    for (const [method, answer] of Object.entries(answers)) {
      handlers[method] = () => {
        if (answer instanceof Error) throw answer
        return answer
      }
    }
    const server = await connectRawMcpServer(name, { capabilities: { resources: {} }, answers: handlers })
    servers.push(server)
    const { client } = server.connection
    const asked: Array<{ method: string; timeout?: number }> = []
    const listResources = client.listResources.bind(client)
    client.listResources = (params, options) => {
      asked.push({ method: 'resources/list', timeout: options?.timeout })
      return listResources(params, options)
    }
    const listTemplates = client.listResourceTemplates.bind(client)
    client.listResourceTemplates = (params, options) => {
      asked.push({ method: 'resources/templates/list', timeout: options?.timeout })
      return listTemplates(params, options)
    }
    return Object.assign(server.connection, { asked })
  }

  test('call() lists resources and resource templates, each with its server', async () => {
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        await resourceServer('files', {
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

  test('call() treats a server without templates/list as having no templates, and asks it once', async () => {
    const { ProtocolError, ProtocolErrorCode } = await import('@modelcontextprotocol/client')
    const server = await resourceServer('no-templates', {
      'resources/list': { resources: [{ uri: 'res://only', name: 'only' }] },
      'resources/templates/list': new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found'),
    })
    for (let call = 0; call < 2; call++) {
      const { data } = await ListMcpResourcesTool.call({} as never, ctxWithClients([server]))
      expect(data).toEqual([{ uri: 'res://only', name: 'only', server: 'no-templates' }])
    }
    // "No templates" is an answer, cached like one.
    expect(server.asked.filter(a => a.method === 'resources/templates/list')).toHaveLength(1)
  })

  test('call() keeps a server’s resources, and the other servers, when its templates list fails', async () => {
    const { data } = await ListMcpResourcesTool.call(
      {} as never,
      ctxWithClients([
        await resourceServer('flaky', {
          'resources/list': { resources: [{ uri: 'res://f', name: 'f' }] },
          'resources/templates/list': new Error('socket hang up'),
        }),
        await resourceServer('steady', { 'resources/list': { resources: [{ uri: 'res://s', name: 's' }] }, 'resources/templates/list': { resourceTemplates: [] } }),
      ]),
    )
    expect(data).toEqual([
      { uri: 'res://f', name: 'f', server: 'flaky' },
      { uri: 'res://s', name: 's', server: 'steady' },
    ])
  })

  test('call() takes any failed templates list as no templates, until the cache is cleared', async () => {
    const server = await resourceServer('broken-templates', {
      'resources/list': { resources: [{ uri: 'res://b', name: 'b' }] },
      'resources/templates/list': new Error('Internal error'),
    })
    for (let call = 0; call < 2; call++) {
      const { data } = await ListMcpResourcesTool.call({} as never, ctxWithClients([server]))
      expect(data).toEqual([{ uri: 'res://b', name: 'b', server: 'broken-templates' }])
    }
    expect(server.asked.filter(a => a.method === 'resources/templates/list')).toHaveLength(1)
  })

  test('call() gives the templates list 10 s, so a server that never answers cannot hold the tool for 60 s', async () => {
    const server = await resourceServer('slow-templates', {
      'resources/list': { resources: [] },
      'resources/templates/list': { resourceTemplates: [] },
    })
    await ListMcpResourcesTool.call({} as never, ctxWithClients([server]))
    expect(server.asked.find(a => a.method === 'resources/templates/list')?.timeout).toBe(10_000)
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
