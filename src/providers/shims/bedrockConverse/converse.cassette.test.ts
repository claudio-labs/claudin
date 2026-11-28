// Non-Claude models on Bedrock through Converse, end to end through the real
// AWS SDK: the factory routes the model, the SDK signs nothing (skip-auth) and
// sends to the local cassette server, which answers with the event-stream
// frames recorded from Bedrock (src/providers/__fixtures__/cassettes/bedrock-converse/).

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventStreamCodec } from '@smithy/eventstream-codec'

import { resetGlobalConfigForTests, saveGlobalConfig, type ProviderProfile } from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { getAnthropicClient } from 'src/providers/transport/client.js'
import { clientDefersTools } from 'src/providers/shims/clientToolSearch/capability.js'
import { CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/callTool.js'
import { getContextWindowForModel, getModelMaxOutputTokens } from 'src/agent/context/context.js'
import {
  converseContextWindow,
  converseMaxOutputTokens,
  usesConverse,
} from 'src/providers/shims/bedrockConverse/models.js'
import {
  loadCassette,
  recordedRequestBody,
  startCassetteServer,
  type Cassette,
  type CassetteServer,
} from 'src/providers/__testutils__/cassetteServer.js'

const g = globalThis as Record<string, unknown>
const savedMacro = g.MACRO
g.MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }
const ENVS = ['ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDIN_SKIP_BEDROCK_AUTH', 'AWS_REGION', 'CLAUDIN_SHIM_TOOL_SEARCH'] as const
const savedEnv = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))

const NOVA = 'us.amazon.nova-micro-v1:0'
const CLAUDE = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
const WEATHER = {
  name: 'get_weather',
  description: 'Get current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
}

let server: CassetteServer | undefined

function useBedrock(model: string, baseUrl = 'http://127.0.0.1:1'): void {
  const profile: ProviderProfile = { id: 'bedrock', name: 'Bedrock', provider: 'bedrock', baseUrl, model }
  saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
  invalidateActiveProviderCache()
}

async function serve(cassettes: Cassette[], model = NOVA): Promise<CassetteServer> {
  server = await startCassetteServer(cassettes)
  process.env.ANTHROPIC_BEDROCK_BASE_URL = server.url
  useBedrock(model, server.url)
  return server
}

beforeEach(() => {
  resetGlobalConfigForTests()
  process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
  process.env.AWS_REGION = 'us-east-1'
  delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
})

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const name of ENVS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  g.MACRO = savedMacro
})

type Messages = {
  create: (params: Record<string, unknown>) => Promise<any> & {
    withResponse: () => Promise<{ data: any; response: Response; request_id?: string }>
  }
  keepAlivePingParams?: (params: Record<string, unknown>) => unknown
}

async function messages(model = NOVA): Promise<Messages> {
  const client = await getAnthropicClient({ maxRetries: 0, model })
  return (client as unknown as { beta: { messages: Messages } }).beta.messages
}

async function stream(params: Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const { data } = await (await messages()).create({ model: NOVA, ...params, stream: true }).withResponse()
  const events: Array<Record<string, any>> = []
  for await (const event of data) events.push(event)
  return events
}

/** The text, tool calls, stop reason and usage a stream of Anthropic events adds up to. */
function summarize(events: Array<Record<string, any>>) {
  const blocks = new Map<number, Record<string, any>>()
  let stop: string | undefined
  let usage: Record<string, number> | undefined
  for (const e of events) {
    if (e.type === 'content_block_start') blocks.set(e.index, { ...e.content_block, json: '' })
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') blocks.get(e.index)!.text += e.delta.text
    if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') blocks.get(e.index)!.json += e.delta.partial_json
    if (e.type === 'message_delta') {
      stop = e.delta.stop_reason
      usage = e.usage
    }
  }
  const content = [...blocks.values()].map(({ json, ...b }) => (b.type === 'tool_use' ? { ...b, input: JSON.parse(json) } : b))
  return { content, stop, usage }
}

/** The recorded body as the SDK sends it: the model id rides in the path. */
function recordedWireBody(cassette: Cassette, index = 0): Record<string, unknown> {
  const { modelId: _modelId, ...body } = recordedRequestBody(cassette, index)
  return body
}

describe('which Bedrock models take Converse', () => {
  test('every model but Claude, and an ARN stays on the Claude path', () => {
    for (const model of [NOVA, 'meta.llama4-maverick-17b-instruct-v1:0', 'deepseek.r1-v1:0', 'openai.gpt-oss-120b-1:0']) {
      expect(usesConverse(model)).toBe(true)
    }
    for (const model of [CLAUDE, 'anthropic.claude-3-haiku-20240307-v1:0', 'arn:aws:bedrock:us-east-1:1:application-inference-profile/x', '', undefined]) {
      expect(usesConverse(model)).toBe(false)
    }
  })

  test('the factory hands Claude to AnthropicBedrock and Nova to the Converse client, wrapped for tool search', async () => {
    useBedrock(CLAUDE)
    const claude = await messages(CLAUDE)
    expect(claude.keepAlivePingParams).toBeUndefined()
    expect(clientDefersTools(CLAUDE)).toBe(false)

    useBedrock(NOVA)
    const nova = await messages(NOVA)
    expect(nova.keepAlivePingParams?.({})).toBeNull()
    expect('countTokens' in nova).toBe(false)
    expect(clientDefersTools()).toBe(true)
  })

  test('the limits: the table for Converse models, Claude unchanged', () => {
    useBedrock(NOVA)
    expect(getContextWindowForModel(NOVA)).toBe(128_000)
    expect(getModelMaxOutputTokens(NOVA)).toEqual({ default: 10_000, upperLimit: 10_000 })
    expect(getModelMaxOutputTokens('meta.llama3-3-70b-instruct-v1:0').upperLimit).toBe(2_048)
    useBedrock(CLAUDE)
    expect(getContextWindowForModel(CLAUDE)).toBe(200_000)
    expect(getModelMaxOutputTokens(CLAUDE).upperLimit).toBe(64_000)
  })

  test('an unknown family gets the conservative fallback', () => {
    expect(converseContextWindow('writer.palmyra-x5-v1:0')).toBe(128_000)
    expect(converseMaxOutputTokens('writer.palmyra-x5-v1:0')).toBe(8_192)
    expect(converseContextWindow('amazon.nova-pro-v1:0')).toBe(300_000)
    expect(converseContextWindow('qwen.qwen3-32b-v1:0')).toBe(32_768)
  })
})

describe('the recorded Converse exchanges', () => {
  test('text: the request is the recorded one, and the answer streams back', async () => {
    const cassette = loadCassette('bedrock-converse/streams-text')
    const srv = await serve([cassette])
    const events = await stream({
      max_tokens: 16,
      temperature: 0,
      system: [{ type: 'text', text: "Reply with the single word 'Hello'.", cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Say hello.' }],
      thinking: { type: 'disabled' },
      metadata: { user_id: 'x' },
    })
    expect(srv.unmatched).toEqual([])
    expect(decodeURIComponent(srv.captures[0]!.path)).toBe(`/model/${NOVA}/converse-stream`)
    expect(srv.captures[0]!.json).toEqual(recordedWireBody(cassette))
    expect(summarize(events)).toEqual({
      content: [{ type: 'text', text: 'Hello' }],
      stop: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    expect(events[0]!.type).toBe('message_start')
    expect(events.at(-1)!.type).toBe('message_stop')
  })

  test('a forced tool call: toolConfig as recorded, and the call comes back as a tool_use', async () => {
    const cassette = loadCassette('bedrock-converse/streams-a-tool-call')
    const srv = await serve([cassette])
    const events = await stream({
      max_tokens: 80,
      temperature: 0,
      system: 'Call tools exactly as requested.',
      messages: [{ role: 'user', content: 'Call get_weather with city exactly Paris.' }],
      tools: [WEATHER],
      tool_choice: { type: 'tool', name: 'get_weather' },
    })
    expect(srv.captures[0]!.json).toEqual(recordedWireBody(cassette))
    expect(summarize(events)).toMatchObject({
      content: [{ type: 'tool_use', id: 'tooluse_6a1pPvnc99GLKO3KGkUA2N', name: 'get_weather', input: { city: 'Paris' } }],
      stop: 'tool_use',
    })
  })

  test('a tool loop: text then a call, and the call and its result go back as toolUse and toolResult', async () => {
    const cassette = loadCassette('bedrock-converse/drives-a-tool-loop')
    const srv = await serve([cassette])
    const base = {
      max_tokens: 80,
      temperature: 0,
      system: 'Use the get_weather tool, then answer in one short sentence.',
      tools: [WEATHER],
    }
    const first = summarize(await stream({ ...base, messages: [{ role: 'user', content: 'What is the weather in Paris?' }] }))
    expect(first.stop).toBe('tool_use')
    expect(first.content.map(b => b.type)).toEqual(['text', 'tool_use'])
    const call = first.content[1]!

    const second = summarize(
      await stream({
        ...base,
        messages: [
          { role: 'user', content: 'What is the weather in Paris?' },
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'hidden', signature: 's' }, { type: 'text', text: ' \n' }, ...first.content],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"temperature":22,"condition":"sunny"}' }],
          },
        ],
      }),
    )
    expect(second.content).toEqual([{ type: 'text', text: 'The weather in Paris is sunny with a temperature of 22 degrees.' }])
    const sent = srv.captures[1]!.json as { messages: Array<{ role: string; content: Array<Record<string, any>> }> }
    const recorded = recordedWireBody(cassette, 1) as typeof sent
    // The thinking and blank text blocks stay behind; the rest is the recorded turn, the result as text not json.
    expect(sent.messages[1]).toEqual(recorded.messages[1]!)
    expect(sent.messages[2]!.content[0]!.toolResult).toEqual({
      toolUseId: call.id,
      content: [{ text: '{"temperature":22,"condition":"sunny"}' }],
      status: 'success',
    })
  })

  test('parallel calls and their results stay paired and in order', async () => {
    const cassette = loadCassette('bedrock-converse/continues-after-parallel-tool-results')
    const srv = await serve([cassette])
    await stream({
      max_tokens: 80,
      tools: [WEATHER],
      messages: [
        { role: 'user', content: 'Compare the weather in Paris and London.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'weather_paris', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'weather_london', name: 'get_weather', input: { city: 'London' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'weather_paris', content: 'sunny' },
            { type: 'tool_result', tool_use_id: 'weather_london', content: [{ type: 'text', text: 'rainy' }], is_error: true },
          ],
        },
      ],
    })
    const sent = srv.captures[0]!.json as { messages: Array<{ content: Array<Record<string, any>> }> }
    expect(sent.messages[1]!.content.map(b => b.toolUse.toolUseId)).toEqual(['weather_paris', 'weather_london'])
    expect(sent.messages[2]!.content.map(b => [b.toolResult.toolUseId, b.toolResult.status])).toEqual([
      ['weather_paris', 'success'],
      ['weather_london', 'error'],
    ])
  })

  test('a whole message for a caller that does not stream', async () => {
    await serve([loadCassette('bedrock-converse/streams-text')])
    const message = await (await messages()).create({ model: NOVA, max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] })
    expect(message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 2 },
    })
  })
})

const codec = new EventStreamCodec(
  bytes => new TextDecoder().decode(bytes),
  text => new TextEncoder().encode(text),
)

/** Converse events as Bedrock frames them; an `exception` entry is an exception frame. */
function frames(events: Array<Record<string, unknown>>): string {
  const parts = events.map(event => {
    const [type, value] = Object.entries(event)[0]!
    const exception = type.endsWith('Exception')
    return codec.encode({
      headers: {
        ':message-type': { type: 'string', value: exception ? 'exception' : 'event' },
        [exception ? ':exception-type' : ':event-type']: { type: 'string', value: type },
        ':content-type': { type: 'string', value: 'application/json' },
      },
      body: new TextEncoder().encode(JSON.stringify(value)),
    })
  })
  return Buffer.concat(parts.map(p => Buffer.from(p))).toString('base64')
}

function scripted(response: { status: number; headers?: Record<string, string>; body: string; base64?: boolean }): Cassette {
  return {
    version: 1,
    interactions: [
      {
        request: { method: 'POST', url: `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(NOVA)}/converse-stream` },
        response: {
          status: response.status,
          headers: response.headers ?? { 'content-type': 'application/vnd.amazon.eventstream' },
          body: response.body,
          ...(response.base64 !== false && { bodyEncoding: 'base64' as const }),
        },
      },
    ],
  }
}

describe('what the recordings do not show', () => {
  test('deferred tools stay behind the gateway, and a gateway call comes back as the tool it names', async () => {
    const srv = await serve([
      scripted({
        status: 200,
        body: frames([
          { messageStart: { role: 'assistant' } },
          { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu_1', name: CALL_TOOL_NAME } } } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"name":"mcp__a","arguments":{"q":1}}' } } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'tool_use' } },
          { metadata: { usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 } } },
        ]),
      }),
    ])
    const events = await stream({
      max_tokens: 80,
      messages: [{ role: 'user', content: 'go' }],
      tools: [WEATHER, { name: 'mcp__a', description: 'A.', input_schema: { type: 'object', properties: {} }, defer_loading: true }],
    })
    const sent = srv.captures[0]!.json as { toolConfig: { tools: Array<{ toolSpec: { name: string } }> } }
    expect(sent.toolConfig.tools.map(t => t.toolSpec.name)).toEqual(['get_weather', CALL_TOOL_NAME])
    expect(summarize(events)).toMatchObject({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__a', input: { q: 1 } }],
      stop: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    })
  })

  test('reasoning comes back as a thinking block with its signature', async () => {
    await serve([
      scripted({
        status: 200,
        body: frames([
          { messageStart: { role: 'assistant' } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hmm' } } } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'ok' } } },
          { messageStop: { stopReason: 'max_tokens' } },
        ]),
      }),
    ])
    const events = await stream({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    const deltas = events.filter(e => e.type === 'content_block_delta').map(e => e.delta)
    expect(deltas).toEqual([
      { type: 'thinking_delta', thinking: 'hmm' },
      { type: 'signature_delta', signature: 'sig' },
      { type: 'text_delta', text: 'ok' },
    ])
    // The text block the stream never stopped is closed before the message ends.
    expect(events.filter(e => e.type === 'content_block_stop').map(e => e.index)).toEqual([0, 1])
    expect(summarize(events).stop).toBe('max_tokens')
  })

  test('a rejected request is the API error the retry loop reads, with its status', async () => {
    await serve([
      scripted({
        status: 400,
        headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/' },
        body: JSON.stringify({ message: 'The model returned the following errors: maxTokens too large' }),
        base64: false,
      }),
    ])
    const error = await stream({ max_tokens: 999_999, messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)
    expect(error.status).toBe(400)
    expect(error.message).toContain('ValidationException')
    expect(error.message).toContain('maxTokens too large')
  })

  test('an exception frame mid-stream is thrown as a 500 with its message: the SDK drops its type', async () => {
    await serve([
      scripted({
        status: 200,
        body: frames([
          { messageStart: { role: 'assistant' } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'par' } } },
          { throttlingException: { message: 'slow down' } },
        ]),
      }),
    ])
    const error = await stream({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }).catch(e => e)
    expect(error.status).toBe(500)
    expect(error.message).toContain('slow down')
  })

  test('images and PDFs go as bytes, in the message and in a tool result; an unknown format stays behind', async () => {
    const png = Buffer.from('png-bytes').toString('base64')
    const pdf = Buffer.from('%PDF-1.7').toString('base64')
    const srv = await serve([loadCassette('bedrock-converse/streams-text')])
    await stream({
      max_tokens: 16,
      tools: [WEATHER],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: png } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
            { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain doc' } },
            { type: 'text', text: 'read these' },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Paris' } }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'map:' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
              ],
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'get_weather', input: { city: 'Rome' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [], is_error: true }] },
      ],
    })
    const sent = srv.captures[0]!.json as { messages: Array<{ content: Array<Record<string, any>> }> }
    expect(sent.messages[0]!.content).toEqual([
      { image: { format: 'png', source: { bytes: png } } },
      { document: { format: 'pdf', name: 'document-1', source: { bytes: pdf } } },
      { text: 'plain doc' },
      { text: 'read these' },
    ])
    expect(sent.messages[2]!.content[0]!.toolResult.content).toEqual([
      { text: 'map:' },
      { image: { format: 'jpeg', source: { bytes: png } } },
      // Names stay unique across the whole request.
      { document: { format: 'pdf', name: 'document-3', source: { bytes: pdf } } },
    ])
    expect(sent.messages[4]!.content[0]!.toolResult).toEqual({ toolUseId: 't2', content: [{ text: 'Error' }], status: 'error' })
  })

  test('without tools, history tool blocks go as text, since Converse refuses them without toolConfig', async () => {
    const srv = await serve([loadCassette('bedrock-converse/streams-text')])
    await stream({
      max_tokens: 16,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }, { type: 'text', text: 'now?' }] },
      ],
    })
    const sent = srv.captures[0]!.json as { toolConfig?: unknown; messages: Array<{ content: Array<Record<string, any>> }> }
    expect(sent.toolConfig).toBeUndefined()
    expect(sent.messages[1]!.content).toEqual([{ text: '[Called Read with {"file_path":"a"}]' }])
    expect(sent.messages[2]!.content).toEqual([{ text: '[Result of t1]\nbody' }, { text: 'now?' }])
  })
})
