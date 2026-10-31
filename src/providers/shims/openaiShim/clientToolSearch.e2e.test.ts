// Client-side tool search through the openai shim, end to end: deferred tools
// leave `tools[]`, a ToolSearch result carries their schema as text, and one
// fixed gateway function calls them — so `tools[]` never changes mid-session.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  makeSseResponse,
  makeStreamChunks,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'
import { CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/index.js'

useShimHarness()

const BASH = {
  name: 'Bash',
  description: 'Run a command.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}
const TOOL_SEARCH = {
  name: 'ToolSearch',
  description: 'Load deferred tools.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}
const ENDPOINT_LIST = {
  name: 'mcp__portainer__EndpointList',
  description: 'List Portainer environments.',
  input_schema: { type: 'object', properties: { select: { type: 'string' } } },
  defer_loading: true,
}
const SETTINGS_UPDATE = {
  name: 'mcp__portainer__SettingsUpdate',
  description: 'Update settings.',
  input_schema: { type: 'object', properties: { body: { type: 'object' } } },
  defer_loading: true,
}
const TOOLS = [BASH, TOOL_SEARCH, ENDPOINT_LIST, SETTINGS_UPDATE]

let savedKillswitch: string | undefined

beforeEach(() => {
  savedKillswitch = process.env.CLAUDIN_SHIM_TOOL_SEARCH
  delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
})

afterEach(() => {
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  else process.env.CLAUDIN_SHIM_TOOL_SEARCH = savedKillswitch
})

type Body = {
  tools?: Array<{ function: { name: string; description: string; parameters: unknown } }>
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>
  tool_choice?: unknown
}

function textChunks(): string[] {
  return makeStreamChunks([
    { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])
}

function capture(bodies: Body[], chunks: () => string[] = textChunks): FetchType {
  return (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body)
    return makeSseResponse(chunks())
  }) as FetchType
}

async function send(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({ model: 'qwen3:8b', max_tokens: 64, stream: true, tools: TOOLS, ...params })
    .withResponse()
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) events.push(event)
  return events
}

const FIRST_TURN = [{ role: 'user', content: 'lista os endpoints do portainer' }]

const AFTER_DISCOVERY = [
  ...FIRST_TURN,
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__portainer__EndpointList' } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'mcp__portainer__EndpointList' }] },
      { type: 'text', text: 'Tool loaded.' },
    ],
  },
]

const AFTER_CALL = [
  ...AFTER_DISCOVERY,
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't2', name: 'mcp__portainer__EndpointList', input: { select: '[].Id' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '[1, 2]' }] },
]

describe('tools[]', () => {
  test('deferred tools leave tools[]; ToolSearch and the gateway are sent', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: FIRST_TURN })

    expect(bodies[0]?.tools?.map(t => t.function.name)).toEqual(['Bash', 'ToolSearch', CALL_TOOL_NAME])
  })

  test('tools[] is byte-identical before and after a discovery', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: FIRST_TURN })
    await send({ messages: AFTER_DISCOVERY })
    await send({ messages: AFTER_CALL })

    expect(JSON.stringify(bodies[1]?.tools)).toBe(JSON.stringify(bodies[0]?.tools))
    expect(JSON.stringify(bodies[2]?.tools)).toBe(JSON.stringify(bodies[0]?.tools))
  })

  test('with no deferred tool in the request nothing changes: no gateway', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: FIRST_TURN, tools: [BASH, TOOL_SEARCH] })

    expect(bodies[0]?.tools?.map(t => t.function.name)).toEqual(['Bash', 'ToolSearch'])
  })

  test('a tool named in tool_choice is sent whole for that request', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: FIRST_TURN, tool_choice: { type: 'tool', name: 'mcp__portainer__EndpointList' } })

    const names = bodies[0]?.tools?.map(t => t.function.name)
    expect(names).toContain('mcp__portainer__EndpointList')
    expect(bodies[0]?.tool_choice).toEqual({ type: 'function', function: { name: 'mcp__portainer__EndpointList' } })
  })

  test('CLAUDIN_SHIM_TOOL_SEARCH=0 sends every tool whole, as before', async () => {
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: FIRST_TURN })

    expect(bodies[0]?.tools?.map(t => t.function.name)).toEqual([
      'Bash',
      'ToolSearch',
      'mcp__portainer__EndpointList',
      'mcp__portainer__SettingsUpdate',
    ])
  })
})

describe('history', () => {
  test('a ToolSearch result carries the loaded schema as text', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: AFTER_DISCOVERY })

    const toolMessage = bodies[0]?.messages.find(m => m.role === 'tool')
    const text = String(toolMessage?.content)
    expect(text).toContain(CALL_TOOL_NAME)
    expect(text).toContain('<functions><function>')
    expect(text).toContain('"name":"mcp__portainer__EndpointList"')
    expect(text).toContain('"select"')
  })

  test('the "Tool loaded." sibling does not invent an interrupted assistant turn', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: AFTER_DISCOVERY })

    const contents = bodies[0]?.messages.map(m => JSON.stringify(m.content ?? ''))
    expect(contents?.some(c => c.includes('[Tool execution interrupted by user]'))).toBe(false)
  })

  test('a deferred tool call in history is sent as a gateway call, same id', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: AFTER_CALL })

    const call = bodies[0]?.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === 't2')
    expect(call?.function.name).toBe(CALL_TOOL_NAME)
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({
      name: 'mcp__portainer__EndpointList',
      arguments: { select: '[].Id' },
    })
  })

  test('the rendered history is byte-identical on the next request', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies)

    await send({ messages: AFTER_CALL })
    await send({ messages: [...AFTER_CALL, { role: 'user', content: 'e agora?' }] })

    const first = bodies[0]?.messages ?? []
    const second = bodies[1]?.messages.slice(0, first.length) ?? []
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})

describe('the model calling through the gateway', () => {
  test('a streamed gateway call becomes a tool_use of the real tool', async () => {
    const bodies: Body[] = []
    const args = JSON.stringify({ name: 'mcp__portainer__EndpointList', arguments: { select: '[].Id' } })
    globalThis.fetch = capture(bodies, () =>
      makeStreamChunks([
        {
          id: 'c',
          object: 'chat.completion.chunk',
          model: 'm',
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: CALL_TOOL_NAME, arguments: args.slice(0, 20) } }] },
            finish_reason: null,
          }],
        },
        {
          id: 'c',
          object: 'chat.completion.chunk',
          model: 'm',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] }, finish_reason: null }],
        },
        { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    )

    const events = await send({ messages: AFTER_DISCOVERY })

    const start = events.find(
      e => e.type === 'content_block_start' && (e.content_block as { type?: string })?.type === 'tool_use',
    ) as { content_block: { name: string; id: string } } | undefined
    expect(start?.content_block.name).toBe('mcp__portainer__EndpointList')
    expect(start?.content_block.id).toBe('call_1')
    const json = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type?: string })?.type === 'input_json_delta')
      .map(e => (e.delta as { partial_json: string }).partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ select: '[].Id' })
  })

  test('a non-streaming gateway call becomes a tool_use of the real tool', async () => {
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      Response.json({
        id: 'c',
        model: 'm',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_2',
              type: 'function',
              function: { name: CALL_TOOL_NAME, arguments: JSON.stringify({ name: 'mcp__portainer__EndpointList', arguments: { select: 'x' } }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })) as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const message = (await client.beta.messages.create({
      model: 'qwen3:8b',
      max_tokens: 64,
      stream: false,
      tools: TOOLS,
      messages: AFTER_DISCOVERY,
    })) as { content: Array<{ type: string; name?: string; id?: string; input?: unknown }> }

    const toolUse = message.content.find(b => b.type === 'tool_use')
    expect(toolUse?.name).toBe('mcp__portainer__EndpointList')
    expect(toolUse?.id).toBe('call_2')
    expect(toolUse?.input).toEqual({ select: 'x' })
  })
})

describe('gateway calls in the stream, edge shapes', () => {
  function chunk(delta: Record<string, unknown>, finish: string | null = null) {
    return { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] }
  }

  function toolStarts(events: Array<Record<string, unknown>>) {
    return events
      .filter(e => e.type === 'content_block_start' && (e.content_block as { type?: string })?.type === 'tool_use')
      .map(e => ({ index: e.index, name: (e.content_block as { name: string }).name }))
  }

  test('a gateway call followed by a direct call keeps index order', async () => {
    const bodies: Body[] = []
    const args = JSON.stringify({ name: 'mcp__portainer__EndpointList', arguments: {} })
    globalThis.fetch = capture(bodies, () =>
      makeStreamChunks([
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'g', type: 'function', function: { name: CALL_TOOL_NAME, arguments: args } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }),
        chunk({}, 'tool_calls'),
      ]),
    )

    const events = await send({ messages: AFTER_DISCOVERY })

    expect(toolStarts(events)).toEqual([
      { index: 0, name: 'mcp__portainer__EndpointList' },
      { index: 1, name: 'Bash' },
    ])
  })

  test('arguments that name no tool keep the gateway name, so the loop reports it', async () => {
    const bodies: Body[] = []
    globalThis.fetch = capture(bodies, () =>
      makeStreamChunks([
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'g', type: 'function', function: { name: CALL_TOOL_NAME, arguments: '{"arguments":{}}' } }] }),
        chunk({}, 'tool_calls'),
      ]),
    )

    const events = await send({ messages: AFTER_DISCOVERY })

    expect(toolStarts(events)).toEqual([{ index: 0, name: CALL_TOOL_NAME }])
  })

  test('a gateway call the model wrote as <tool_call> text is recovered as the real tool', async () => {
    const bodies: Body[] = []
    const xml = `<tool_call>${JSON.stringify({ name: CALL_TOOL_NAME, arguments: { name: 'mcp__portainer__EndpointList', arguments: { select: 'x' } } })}</tool_call>`
    globalThis.fetch = capture(bodies, () =>
      makeStreamChunks([chunk({ role: 'assistant', content: xml }), chunk({}, 'stop')]),
    )

    const events = await send({ messages: AFTER_DISCOVERY })

    expect(toolStarts(events).map(s => s.name)).toEqual(['mcp__portainer__EndpointList'])
    const json = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as { type?: string })?.type === 'input_json_delta')
      .map(e => (e.delta as { partial_json: string }).partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ select: 'x' })
  })
})
