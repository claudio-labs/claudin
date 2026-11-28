import { afterEach, describe, expect, test } from 'bun:test'

import { CALL_TOOL, CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/callTool.js'
import { gatewayEvents, gatewayMessage } from 'src/providers/shims/clientToolSearch/eventTransform.js'
import { applyClientToolSearch } from 'src/providers/shims/clientToolSearch/paramsTransform.js'
import { withClientToolSearch } from 'src/providers/shims/clientToolSearch/wrapClient.js'

const savedKillswitch = process.env.CLAUDIN_SHIM_TOOL_SEARCH

afterEach(() => {
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  else process.env.CLAUDIN_SHIM_TOOL_SEARCH = savedKillswitch
})

const BASH = { name: 'Bash', input_schema: { type: 'object', properties: {} } }
const DEFERRED = { name: 'mcp__a', description: 'A.', input_schema: { type: 'object', properties: { q: { type: 'string' } } }, defer_loading: true }
const OTHER = { name: 'mcp__b', defer_loading: true }

type Event = Record<string, any>

async function collect(events: Event[]): Promise<Event[]> {
  async function* source() {
    yield* events
  }
  const out: Event[] = []
  for await (const event of gatewayEvents(source())) out.push(event)
  return out
}

function toolBlock(index: number, id: string, name: string, json: string[]): Event[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...json.map(partial_json => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
  ]
}

describe('applyClientToolSearch', () => {
  test('params without a deferred tool come back as the same object, inactive', () => {
    const params = { tools: [BASH], messages: [] }
    expect(applyClientToolSearch(params)).toEqual({ params, active: false })
    expect(applyClientToolSearch(params).params).toBe(params)
  })

  test('deferred tools leave, CallTool joins last, and no defer flag is left', () => {
    const { params, active } = applyClientToolSearch({ tools: [BASH, DEFERRED, OTHER], messages: [] })
    expect(active).toBe(true)
    expect((params.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['Bash', CALL_TOOL_NAME])
    expect((params.tools as unknown[]).at(-1)).toBe(CALL_TOOL)
  })

  test('a tool forced by tool_choice stays, without its defer flag', () => {
    const { params } = applyClientToolSearch({
      tools: [BASH, DEFERRED, OTHER],
      tool_choice: { type: 'tool', name: 'mcp__a' },
      messages: [],
    })
    const tools = params.tools as Array<Record<string, unknown>>
    expect(tools.map(tool => tool.name)).toEqual(['Bash', 'mcp__a', CALL_TOOL_NAME])
    expect(tools[1]).not.toHaveProperty('defer_loading')
  })

  test('when the only deferred tool is forced there is no gateway', () => {
    const { params, active } = applyClientToolSearch({
      tools: [BASH, DEFERRED],
      tool_choice: { type: 'tool', name: 'mcp__a' },
    })
    expect(active).toBe(false)
    expect((params.tools as Array<Record<string, unknown>>).map(tool => tool.name)).toEqual(['Bash', 'mcp__a'])
    expect((params.tools as Array<Record<string, unknown>>)[1]).not.toHaveProperty('defer_loading')
  })

  test('the killswitch sends every tool whole, defer flags dropped, no gateway', () => {
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    const { params, active } = applyClientToolSearch({ tools: [BASH, DEFERRED] })
    expect(active).toBe(false)
    expect(params.tools as unknown).toEqual([BASH, { name: 'mcp__a', description: 'A.', input_schema: DEFERRED.input_schema }])
  })

  test('history: a reference becomes the schema after the result text, and a deferred call a gateway call', () => {
    const untouched = { role: 'user', content: 'hi' }
    const { params } = applyClientToolSearch({
      tools: [BASH, DEFERRED],
      messages: [
        untouched,
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'found' }, { type: 'tool_reference', tool_name: 'mcp__a' }],
            },
            { type: 'text', text: 'Tool loaded.' },
          ],
        },
        // The wrapped shape some callers pass.
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'mcp__a', input: { q: 'x' } }] } },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] },
      ],
    })
    const [first, loaded, call, bash] = params.messages as Array<Record<string, any>>
    expect(first).toBe(untouched)
    expect(loaded!.content).toHaveLength(1)
    const result = loaded!.content[0]
    expect(result.content[0]).toEqual({ type: 'text', text: 'found' })
    expect(result.content[1].text).toContain('<function>{"description":"A.","name":"mcp__a"')
    expect(call!.message.content[0]).toEqual({
      type: 'tool_use',
      id: 't2',
      name: CALL_TOOL_NAME,
      input: { name: 'mcp__a', arguments: { q: 'x' } },
    })
    expect(call!.type).toBe('assistant')
    expect(bash!.content[0].name).toBe('Bash')
  })

  test('a "Tool loaded." text with no loading result next to it stays', () => {
    const message = { role: 'user', content: [{ type: 'text', text: 'Tool loaded.' }] }
    const { params } = applyClientToolSearch({ tools: [DEFERRED], messages: [message] })
    expect((params.messages as unknown[])[0]).toBe(message)
  })
})

describe('gatewayEvents', () => {
  test('a gateway call comes back as the tool it names, and later blocks keep their order', async () => {
    const args = JSON.stringify({ name: 'mcp__a', arguments: { q: 'x' } })
    const events = await collect([
      { type: 'message_start' },
      ...toolBlock(0, 'g', CALL_TOOL_NAME, [args.slice(0, 10), args.slice(10)]),
      ...toolBlock(1, 'b', 'Bash', ['{"command":"ls"}']),
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ])

    expect(events.map(e => [e.type, e.index ?? null, e.content_block?.name ?? null])).toEqual([
      ['message_start', null, null],
      ['content_block_start', 0, 'mcp__a'],
      ['content_block_delta', 0, null],
      ['content_block_start', 1, 'Bash'],
      ['content_block_delta', 1, null],
      ['content_block_stop', 0, null],
      ['content_block_stop', 1, null],
      ['message_stop', null, null],
    ])
    expect(JSON.parse(events[2]!.delta.partial_json)).toEqual({ q: 'x' })
    expect(events[1]!.content_block.id).toBe('g')
  })

  test('arguments that name no tool keep the gateway name and an empty input', async () => {
    const events = await collect([...toolBlock(0, 'g', CALL_TOOL_NAME, ['{"arguments":{}}']), { type: 'content_block_stop', index: 0 }])
    expect(events[0]!.content_block.name).toBe(CALL_TOOL_NAME)
    expect(events[1]!.delta.partial_json).toBe('{}')
  })

  test('a stream cut before the call stopped still hands over what was held', async () => {
    const events = await collect([...toolBlock(0, 'g', CALL_TOOL_NAME, ['{"name":"mcp__a","arguments":{}}'])])
    expect(events.map(e => e.type)).toEqual(['content_block_start', 'content_block_delta'])
    expect(events[0]!.content_block.name).toBe('mcp__a')
  })

  test('a stream with no gateway call passes through untouched', async () => {
    const input = [...toolBlock(0, 'b', 'Bash', ['{}']), { type: 'content_block_stop', index: 0 }]
    const events = await collect(input)
    expect(events).toEqual(input)
    expect(events[0]).toBe(input[0])
  })
})

describe('gatewayMessage', () => {
  test('unwraps object and double-encoded inputs; other blocks stay', () => {
    const text = { type: 'text', text: 'hi' }
    const message = gatewayMessage({
      content: [
        text,
        { type: 'tool_use', id: '1', name: CALL_TOOL_NAME, input: { name: 'mcp__a', arguments: { q: 1 } } },
        { type: 'tool_use', id: '2', name: CALL_TOOL_NAME, input: '{"name":"mcp__b","arguments":"{\\"z\\":2}"}' },
        { type: 'tool_use', id: '3', name: CALL_TOOL_NAME, input: { arguments: {} } },
      ],
    } as { content: unknown[] })
    expect(message.content[0]).toBe(text)
    expect(message.content[1]).toEqual({ type: 'tool_use', id: '1', name: 'mcp__a', input: { q: 1 } })
    expect(message.content[2]).toEqual({ type: 'tool_use', id: '2', name: 'mcp__b', input: { z: 2 } })
    expect(message.content[3]).toEqual({ type: 'tool_use', id: '3', name: CALL_TOOL_NAME, input: {} })
  })

  test('a message without gateway calls, or without content, is the same object', () => {
    const plain = { content: [{ type: 'text', text: 'x' }] }
    expect(gatewayMessage(plain)).toBe(plain)
    const odd = { content: 'x' }
    expect(gatewayMessage(odd)).toBe(odd)
  })
})

describe('withClientToolSearch', () => {
  function fakeClient(reply: () => unknown) {
    const seen: Array<Record<string, unknown>> = []
    // A private field, as the SDK's resources have: reached through the
    // wrapper's proxy instead of the object itself, it throws.
    class Messages {
      #label = 'inner'
      get label() {
        return this.#label
      }
      keepAlivePingParams(params: Record<string, unknown>) {
        return { ...params, pinged: this.#label }
      }
      create(params: Record<string, unknown>) {
        seen.push(params)
        const data = reply()
        const promise = Promise.resolve(data) as Promise<unknown> & { withResponse: () => Promise<unknown> }
        promise.withResponse = async () => ({ data, request_id: 'r', response: new Response() })
        return promise
      }
    }
    const messages = new Messages()
    return { seen, client: { beta: { messages }, messages, other: 1 } }
  }

  const gatewayReply = () => ({
    content: [{ type: 'tool_use', id: '1', name: CALL_TOOL_NAME, input: { name: 'mcp__a', arguments: {} } }],
  })

  test('the request is transformed, and a whole message comes back unwrapped, awaited or withResponse', async () => {
    const { seen, client } = fakeClient(gatewayReply)
    const wrapped = withClientToolSearch(client)

    const awaited = (await wrapped.beta.messages.create({ tools: [DEFERRED], messages: [] })) as any
    const withResponse = (await (wrapped.beta.messages.create({ tools: [DEFERRED], messages: [] }) as any).withResponse()) as any

    expect((seen[0]!.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual([CALL_TOOL_NAME])
    expect(awaited.content[0].name).toBe('mcp__a')
    expect(withResponse.data.content[0].name).toBe('mcp__a')
    expect(withResponse.request_id).toBe('r')
  })

  test('a stream is unwrapped and keeps its controller', async () => {
    const controller = new AbortController()
    const args = JSON.stringify({ name: 'mcp__a', arguments: {} })
    const stream = {
      controller,
      async *[Symbol.asyncIterator]() {
        yield* [...toolBlock(0, 'g', CALL_TOOL_NAME, [args]), { type: 'content_block_stop', index: 0 }]
      },
    }
    const { client } = fakeClient(() => stream)
    const result = (await (withClientToolSearch(client).beta.messages.create({ tools: [DEFERRED] }) as any).withResponse()) as any

    expect(result.data.controller).toBe(controller)
    const names: string[] = []
    for await (const event of result.data) if (event.type === 'content_block_start') names.push(event.content_block.name)
    expect(names).toEqual(['mcp__a'])
  })

  test('without a deferred tool the inner promise comes back as it is', () => {
    const { client } = fakeClient(gatewayReply)
    const inner = client.beta.messages.create({ tools: [BASH] })
    const wrapped = withClientToolSearch(client)
    const out = wrapped.beta.messages.create({ tools: [BASH] })
    expect(typeof (out as any).withResponse).toBe('function')
    expect(out).not.toBe(inner)
    expect(Object.getPrototypeOf(out)).toBe(Object.getPrototypeOf(inner))
  })

  test('the client keeps its own capabilities, bound to it, and gains none', () => {
    const { client } = fakeClient(gatewayReply)
    const wrapped = withClientToolSearch(client)
    expect(wrapped.beta.messages.keepAlivePingParams({ a: 1 }) as unknown).toEqual({ a: 1, pinged: 'inner' })
    expect('countTokens' in wrapped.beta.messages).toBe(false)
    expect(wrapped.other).toBe(1)
    expect((wrapped.messages as { label: string }).label).toBe('inner')
  })

  test('a rejected request rejects for the caller, without an unhandled rejection', async () => {
    const messages = {
      create(_params?: unknown) {
        const promise = Promise.reject(new Error('boom')) as Promise<unknown> & { withResponse: () => Promise<unknown> }
        promise.withResponse = () => promise
        return promise
      },
    }
    const wrapped = withClientToolSearch({ beta: { messages } })
    await expect((wrapped.beta.messages.create({ tools: [DEFERRED] }) as any).withResponse()).rejects.toThrow('boom')
  })
})
