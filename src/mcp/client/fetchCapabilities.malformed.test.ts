import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as log from 'src/shared/log.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import { connectRawMcpServer, type RawHandler, type RawMcpServer } from 'src/mcp/__testutils__/rawMcpServer.js'
import { callMCPTool } from 'src/mcp/client/callTool.js'

type PromptCommand = { getPromptForCommand: (args: string) => Promise<unknown> }

const servers: RawMcpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

// A raw server whose every list answers one fixed page, joined to a real v2
// Client through the same wire filter connectToServer attaches, so a strict
// list schema fails here exactly as it does on the wire.
async function listServer(name: string, pages: Record<string, unknown>, extra: Record<string, RawHandler> = {}) {
  const prompts: unknown[] = []
  const answers: Record<string, RawHandler> = {
    'prompts/get': params => {
      prompts.push(params)
      return { messages: [] }
    },
    ...extra,
  }
  for (const [method, page] of Object.entries(pages)) answers[method] = () => page
  const server = await connectRawMcpServer(name, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    answers,
  })
  servers.push(server)
  return { client: server.connection, requests: server.requests, prompts }
}

const goodTool = { name: 'good', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }

describe('a tools/list with one malformed tool', () => {
  test('control: a well-formed list keeps every tool in one request', async () => {
    const { client, requests } = await listServer('ok-tools', {
      'tools/list': { tools: [goodTool, { name: 'other', inputSchema: { type: 'object' } }] },
    })
    expect((await fetchToolsForClient(client)).map(t => t.mcpInfo?.toolName)).toEqual(['good', 'other'])
    expect(requests).toHaveLength(1)
  })

  test('keeps the valid tools when one inputSchema is not an object schema', async () => {
    const { client } = await listServer('bad-schema-type', {
      'tools/list': { tools: [goodTool, { name: 'bad', inputSchema: { type: 'string' } }] },
    })
    const logged = spyOn(log, 'logMCPError')
    try {
      expect((await fetchToolsForClient(client)).map(t => t.mcpInfo?.toolName)).toEqual(['good'])
      expect(logged.mock.calls).toContainEqual(['bad-schema-type', 'Skipped tool "bad": inputSchema type is not "object"'])
    } finally {
      logged.mockRestore()
    }
  }, 10_000)

  test('keeps the valid tools when one name is not a string', async () => {
    const { client } = await listServer('bad-name', {
      'tools/list': { tools: [goodTool, { name: 42, inputSchema: { type: 'object' } }] },
    })
    expect((await fetchToolsForClient(client)).map(t => t.mcpInfo?.toolName)).toEqual(['good'])
  }, 10_000)

  test('keeps a tool whose top-level required is malformed, without that field', async () => {
    const { client } = await listServer('bad-required', {
      'tools/list': { tools: [{ name: 'loose', inputSchema: { type: 'object', required: 'q' } }] },
    })
    const tools = await fetchToolsForClient(client)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['loose'])
    expect(tools[0]!.inputJSONSchema).toEqual({ type: 'object' })
  }, 10_000)

  test('does not retry a list that fails its schema as if the failure were transient', async () => {
    const { client, requests } = await listServer('bad-no-retry', {
      'tools/list': { tools: 'not a list' },
    })
    await fetchToolsForClient(client)
    expect(requests).toHaveLength(1)
  }, 10_000)
})

describe('prompts and resources lists with one malformed entry', () => {
  test('keeps the valid prompts', async () => {
    const { client } = await listServer('bad-prompts', {
      'prompts/list': { prompts: [{ name: 'good' }, { name: 'bad', arguments: 'x' }] },
    })
    const logged = spyOn(log, 'logMCPError')
    try {
      expect((await fetchCommandsForClient(client)).map(c => c.name)).toEqual(['mcp__bad-prompts__good'])
      expect(logged.mock.calls.map(call => String(call[1]))).toContainEqual(expect.stringMatching(/^Skipped prompt "bad": arguments/))
    } finally {
      logged.mockRestore()
    }
  })

  test('keeps the valid resources', async () => {
    const { client } = await listServer('bad-resources', {
      'resources/list': { resources: [{ uri: 'file:///ok', name: 'ok' }, { name: 'no-uri' }] },
    })
    const logged = spyOn(log, 'logMCPError')
    try {
      expect((await fetchResourcesForClient(client)).map(r => r.uri)).toEqual(['file:///ok'])
      expect(logged.mock.calls.map(call => String(call[1]))).toContainEqual(expect.stringMatching(/^Skipped resource "no-uri": uri/))
    } finally {
      logged.mockRestore()
    }
  })
})

describe('MCP prompt arguments', () => {
  const reviewPrompt = {
    'prompts/list': {
      prompts: [{ name: 'review', arguments: [{ name: 'file' }, { name: 'focus' }] }],
    },
  }

  test('control: space-separated words fill the arguments in order', async () => {
    const { client, prompts } = await listServer('args-plain', reviewPrompt)
    const [command] = await fetchCommandsForClient(client)
    await (command as unknown as PromptCommand).getPromptForCommand('src/a.ts errors')
    expect(prompts).toEqual([{ name: 'review', arguments: { file: 'src/a.ts', focus: 'errors' } }])
  })

  test('a quoted argument keeps its spaces', async () => {
    const { client, prompts } = await listServer('args-quoted', reviewPrompt)
    const [command] = await fetchCommandsForClient(client)
    await (command as unknown as PromptCommand).getPromptForCommand('src/a.ts "error handling"')
    expect(prompts).toEqual([{ name: 'review', arguments: { file: 'src/a.ts', focus: 'error handling' } }])
  })

  // What the server receives for each line typed after the command: quotes
  // group words, and nothing else in the line is read as shell syntax.
  const cases: Array<[string, Record<string, string>]> = [
    ["src/a.ts 'error handling'", { file: 'src/a.ts', focus: 'error handling' }],
    ['#123 urgent', { file: '#123', focus: 'urgent' }],
    ['src/*.ts errors', { file: 'src/*.ts', focus: 'errors' }],
    ['x>1 y|z', { file: 'x>1', focus: 'y|z' }],
    ["src/a.ts don't", { file: 'src/a.ts', focus: "don't" }],
    ['C:\\Users\\me regex\\d+', { file: 'C:\\Users\\me', focus: 'regex\\d+' }],
    ['$HOME/a.ts $1', { file: '$HOME/a.ts', focus: '$1' }],
    ['a.ts   spaced', { file: 'a.ts', focus: 'spaced' }],
  ]
  for (const [line, expected] of cases) {
    test(`${JSON.stringify(line)} reaches the prompt as typed`, async () => {
      const { client, prompts } = await listServer(`args-${line}`, reviewPrompt)
      const [command] = await fetchCommandsForClient(client)
      await (command as unknown as PromptCommand).getPromptForCommand(line)
      expect(prompts).toEqual([{ name: 'review', arguments: expected }])
    })
  }

  test('no arguments send the first one empty, as before', async () => {
    const { client, prompts } = await listServer('args-none', reviewPrompt)
    const [command] = await fetchCommandsForClient(client)
    await (command as unknown as PromptCommand).getPromptForCommand('')
    expect(JSON.stringify(prompts)).toBe(JSON.stringify([{ name: 'review', arguments: { file: '' } }]))
  })
})

// The SDK's callTool checks a result against the outputSchema it listed, and
// throws when structuredContent is missing; Claudin never did, and a server
// that declares a schema it does not honour (Portainer, in the 10-15 census)
// kept working.
describe('a listed tool with an outputSchema whose call returns no structuredContent', () => {
  const typedTool = {
    name: 'typed',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  }
  const answers = {
    'tools/list': () => ({ tools: [typedTool] }),
    'tools/call': () => ({ content: [{ type: 'text', text: 'plain answer' }] }),
  }

  test('control: the SDK alone refuses the call', async () => {
    const server = await connectRawMcpServer('typed-bare', { capabilities: { tools: {} }, answers, wireFilter: false })
    servers.push(server)
    await server.connection.client.listTools()
    await expect(server.connection.client.callTool({ name: 'typed', arguments: {} })).rejects.toThrow(
      'has an output schema but did not return structured content',
    )
  })

  test('still succeeds through callMCPTool', async () => {
    const server = await connectRawMcpServer('typed-filtered', { capabilities: { tools: {} }, answers })
    servers.push(server)
    const [tool] = await fetchToolsForClient(server.connection)
    expect(tool!.mcpInfo?.toolName).toBe('typed')
    const result = await callMCPTool({
      client: server.connection,
      tool: 'typed',
      args: {},
      signal: new AbortController().signal,
    })
    expect(result.content).toEqual([{ type: 'text', text: 'plain answer' }])
  })
})
