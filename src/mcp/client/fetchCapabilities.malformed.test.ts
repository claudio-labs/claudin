import { describe, expect, spyOn, test } from 'bun:test'
import * as log from 'src/shared/log.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
} from 'src/mcp/client/fetchCapabilities.js'
import type { MCPServerConnection } from 'src/mcp/types.js'

type ListRequest = { method: string; params?: { cursor?: string } }
type Schema = { parse: (value: unknown) => unknown }
type PromptCommand = { getPromptForCommand: (args: string) => Promise<unknown> }

// A server whose every list answers one fixed page. Like the SDK's
// Client.request, the fake validates the result with the schema it is
// handed, so a strict list schema fails here exactly as it does on the wire.
// The config is `sdk` so ensureConnectedClient hands the fake straight back.
function listServer(name: string, pages: Record<string, unknown>) {
  const requests: ListRequest[] = []
  const prompts: unknown[] = []
  const client = {
    type: 'connected',
    name,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    config: { type: 'sdk', name, scope: 'local' },
    cleanup: async () => {},
    client: {
      request: async (req: ListRequest, schema: Schema) => {
        requests.push(req)
        return schema.parse(pages[req.method])
      },
      getPrompt: async (params: unknown) => {
        prompts.push(params)
        return { messages: [] }
      },
    },
  } as unknown as MCPServerConnection
  return { client, requests, prompts }
}

const goodTool = { name: 'good', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }

describe('a tools/list with one malformed tool', () => {
  test('control: a well-formed list keeps every tool in one request', async () => {
    const { client, requests } = listServer('ok-tools', {
      'tools/list': { tools: [goodTool, { name: 'other', inputSchema: { type: 'object' } }] },
    })
    expect((await fetchToolsForClient(client)).map(t => t.mcpInfo?.toolName)).toEqual(['good', 'other'])
    expect(requests).toHaveLength(1)
  })

  test('keeps the valid tools when one inputSchema is not an object schema', async () => {
    const { client } = listServer('bad-schema-type', {
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
    const { client } = listServer('bad-name', {
      'tools/list': { tools: [goodTool, { name: 42, inputSchema: { type: 'object' } }] },
    })
    expect((await fetchToolsForClient(client)).map(t => t.mcpInfo?.toolName)).toEqual(['good'])
  }, 10_000)

  test('keeps a tool whose top-level required is malformed, without that field', async () => {
    const { client } = listServer('bad-required', {
      'tools/list': { tools: [{ name: 'loose', inputSchema: { type: 'object', required: 'q' } }] },
    })
    const tools = await fetchToolsForClient(client)
    expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['loose'])
    expect(tools[0]!.inputJSONSchema).toEqual({ type: 'object' })
  }, 10_000)

  test('does not retry a list that fails its schema as if the failure were transient', async () => {
    const { client, requests } = listServer('bad-no-retry', {
      'tools/list': { tools: 'not a list' },
    })
    await fetchToolsForClient(client)
    expect(requests).toHaveLength(1)
  }, 10_000)
})

describe('prompts and resources lists with one malformed entry', () => {
  test('keeps the valid prompts', async () => {
    const { client } = listServer('bad-prompts', {
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
    const { client } = listServer('bad-resources', {
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
    const { client, prompts } = listServer('args-plain', reviewPrompt)
    const [command] = await fetchCommandsForClient(client)
    await (command as unknown as PromptCommand).getPromptForCommand('src/a.ts errors')
    expect(prompts).toEqual([{ name: 'review', arguments: { file: 'src/a.ts', focus: 'errors' } }])
  })

  test('a quoted argument keeps its spaces', async () => {
    const { client, prompts } = listServer('args-quoted', reviewPrompt)
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
      const { client, prompts } = listServer(`args-${line}`, reviewPrompt)
      const [command] = await fetchCommandsForClient(client)
      await (command as unknown as PromptCommand).getPromptForCommand(line)
      expect(prompts).toEqual([{ name: 'review', arguments: expected }])
    })
  }

  test('no arguments send the first one empty, as before', async () => {
    const { client, prompts } = listServer('args-none', reviewPrompt)
    const [command] = await fetchCommandsForClient(client)
    await (command as unknown as PromptCommand).getPromptForCommand('')
    expect(JSON.stringify(prompts)).toBe(JSON.stringify([{ name: 'review', arguments: { file: '' } }]))
  })
})
