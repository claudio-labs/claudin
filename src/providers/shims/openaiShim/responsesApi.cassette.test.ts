// The Responses API for an openai_compat profile (compatWires.ts → the
// `openai_responses` wire), against requests recorded from api.openai.com and
// Azure OpenAI (src/providers/__fixtures__/cassettes/). The recorded host is
// swapped for the local cassette server at the fetch boundary, so routing,
// URL building and auth all run as they do against the real host.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { clampEffortToValues, resolveShimEffortValues } from 'src/providers/model/reasoningCatalog.js'
import { resolveProviderRequest } from 'src/providers/presets/providerConfig.js'
import { _resetWireFallbackForTesting } from 'src/providers/presets/wireFallback.js'
import {
  loadCassette,
  recordedRequestBody,
  startCassetteServer,
  type Cassette,
  type CassetteServer,
} from 'src/providers/__testutils__/cassetteServer.js'
import { getAnthropicClient } from 'src/providers/transport/client.js'

const g = globalThis as Record<string, unknown>
const savedMacro = g.MACRO
g.MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }
const originalFetch = globalThis.fetch
const ENVS = ['CLAUDIN_OPENAI_RESPONSES', 'CLAUDIN_CODEX_REASONING_REPLAY', 'OPENAI_API_KEY'] as const
const savedEnv = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))

let server: CassetteServer | undefined

const OPENAI: ProviderProfile = {
  id: 'openai',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: 'sk-test-openai',
}
const AZURE: ProviderProfile = {
  id: 'azure',
  name: 'Azure',
  provider: 'openai',
  baseUrl: 'https://example-resource.openai.azure.com/openai/v1',
  model: 'gpt-5.4',
  apiKey: 'azure-key',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
  invalidateActiveProviderCache()
}

/** Serve `cassettes`, and send every request for a real host to the server instead. */
async function serve(cassettes: Cassette[]): Promise<CassetteServer> {
  server = await startCassetteServer(cassettes)
  const target = new URL(server.url)
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
    url.protocol = target.protocol
    url.host = target.host
    return originalFetch(url, init)
  }) as typeof globalThis.fetch
  return server
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const SYSTEM = 'Use the get_weather tool exactly once. After the tool result, reply exactly: Paris is sunny.'
const ASK = { role: 'user', content: 'What is the weather in Paris?' }

async function create(params: Record<string, unknown>): Promise<any> {
  const model = String(params.model ?? OPENAI.model)
  const client = await getAnthropicClient({ maxRetries: 0, model })
  return client.beta.messages.create({ model, max_tokens: 80, ...params } as never)
}

beforeEach(() => {
  for (const name of ENVS) delete process.env[name]
  resetGlobalConfigForTests()
  _resetWireFallbackForTesting()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await server?.close()
  server = undefined
  for (const name of ENVS) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  saveGlobalConfig(current => ({ ...current, providerProfiles: [], activeProviderProfileId: undefined }))
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  _resetWireFallbackForTesting()
})

afterAll(() => {
  g.MACRO = savedMacro
})

describe('which requests take the Responses API', () => {
  test('GPT-5 and later on api.openai.com and Azure v1; earlier models stay on chat', () => {
    useProfile(OPENAI)
    expect(resolveProviderRequest({ model: 'gpt-5.5' }).transport).toBe('openai_responses')
    expect(resolveProviderRequest({ model: 'gpt-6-sol' }).transport).toBe('openai_responses')
    expect(resolveProviderRequest({ model: 'gpt-4.1' }).transport).toBe('chat_completions')
    useProfile(AZURE)
    expect(resolveProviderRequest({ model: 'gpt-5.4' }).transport).toBe('openai_responses')
  })

  test('xAI is unverified: chat unless CLAUDIN_OPENAI_RESPONSES=all', () => {
    useProfile({ ...OPENAI, id: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.2' })
    expect(resolveProviderRequest().transport).toBe('chat_completions')
    process.env.CLAUDIN_OPENAI_RESPONSES = 'all'
    expect(resolveProviderRequest().transport).toBe('openai_responses')
  })

  test('CLAUDIN_OPENAI_RESPONSES=0 keeps OpenAI on chat', () => {
    process.env.CLAUDIN_OPENAI_RESPONSES = '0'
    useProfile(OPENAI)
    expect(resolveProviderRequest().transport).toBe('chat_completions')
  })

  test('the Codex backend and Copilot keep their own Responses path', () => {
    useProfile({ ...OPENAI, id: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex' })
    expect(resolveProviderRequest().transport).toBe('codex_responses')
    useProfile({ ...OPENAI, id: 'gh', baseUrl: 'https://api.githubcopilot.com', model: 'gpt-5.4', extras: { githubToken: 't' } })
    expect(resolveProviderRequest().transport).toBe('codex_responses')
  })
})

describe('the OpenAI Responses wire, from the recordings', () => {
  const toolLoop = loadCassette('openai-responses/openai-responses-gpt-5-5-tool-loop')

  test('the first request: /v1/responses, the profile key, no Codex headers, the fields the API accepted', async () => {
    useProfile(OPENAI)
    const srv = await serve([toolLoop])

    await create({ system: SYSTEM, messages: [ASK], tools: [WEATHER_TOOL], stream: false })

    const sent = srv.captures[0]!
    expect(sent.path).toBe('/v1/responses')
    expect(sent.headers.authorization).toBe('Bearer sk-test-openai')
    expect(sent.headers['session-id']).toBeUndefined()
    expect(sent.headers.originator).toBeUndefined()
    expect(sent.headers['chatgpt-account-id']).toBeUndefined()
    const body = sent.json as Record<string, any>
    const recorded = recordedRequestBody(toolLoop, 0)
    for (const field of ['model', 'store', 'stream', 'include', 'max_output_tokens'] as const) {
      expect(body[field]).toEqual(recorded[field])
    }
    expect(body.prompt_cache_retention).toBe('24h')
    expect(typeof body.prompt_cache_key).toBe('string')
    expect(body).not.toHaveProperty('text')
    expect(body.reasoning ?? {}).not.toHaveProperty('context')
  })

  test('a tool loop replays the reasoning and the call under the ids the API gave them', async () => {
    useProfile(OPENAI)
    const srv = await serve([toolLoop])

    const first = await create({ system: SYSTEM, messages: [ASK], tools: [WEATHER_TOOL], stream: false })
    const call = first.content.find((block: any) => block.type === 'tool_use')
    expect(call).toMatchObject({ name: 'get_weather', input: { city: 'Paris' } })

    await create({
      system: SYSTEM,
      tools: [WEATHER_TOOL],
      stream: false,
      messages: [
        ASK,
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'sunny' }] },
      ],
    })

    const replayed = (srv.captures[1]!.json as Record<string, any>).input
    const recorded = recordedRequestBody(toolLoop, 1).input as Array<Record<string, unknown>>
    const pick = (items: Array<Record<string, any>>, type: string) => items.find(item => item.type === type)
    // The API encrypts the item afresh in each event that carries it; any of
    // them decrypts. The non-streamed answer keeps response.completed's.
    const reasoning = pick(replayed, 'reasoning')!
    expect(reasoning.id).toBe(pick(recorded, 'reasoning')!.id)
    expect(toolLoop.interactions[0]!.response.body).toContain(reasoning.encrypted_content)
    expect(pick(replayed, 'function_call')).toMatchObject({
      id: pick(recorded, 'function_call')!.id,
      call_id: pick(recorded, 'function_call')!.call_id,
      name: 'get_weather',
    })
    expect(srv.unmatched).toHaveLength(0)
  })

  test('an assistant message is replayed without the id the Codex backend would get', async () => {
    useProfile(OPENAI)
    const continuation = loadCassette('openai-responses/openai-responses-gpt-5-5-reasoning-continuation')
    const srv = await serve([continuation])

    const first = await create({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    await create({
      stream: false,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: first.content }, { role: 'user', content: 'and?' }],
    })

    const replayed = (srv.captures[1]!.json as Record<string, any>).input as Array<Record<string, unknown>>
    const assistant = replayed.find(item => item.type === 'message' && item.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant).not.toHaveProperty('id')
    expect(replayed.some(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string')).toBe(true)
  })

  test('with the replay killswitch nothing is asked back or replayed', async () => {
    process.env.CLAUDIN_CODEX_REASONING_REPLAY = '0'
    useProfile(OPENAI)
    const srv = await serve([toolLoop])

    await create({ system: SYSTEM, messages: [ASK], tools: [WEATHER_TOOL], stream: false })

    expect(srv.captures[0]!.json).not.toHaveProperty('include')
  })

  test('a streamed answer is read as Responses events', async () => {
    useProfile(OPENAI)
    await serve([toolLoop])

    const result = await (await getAnthropicClient({ maxRetries: 0, model: 'gpt-5.5' })).beta.messages
      .create({ model: 'gpt-5.5', max_tokens: 80, stream: true, system: SYSTEM, messages: [ASK], tools: [WEATHER_TOOL] } as never)
      .withResponse()
    const names: string[] = []
    for await (const event of result.data as unknown as AsyncIterable<any>) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') names.push(event.content_block.name)
    }
    expect(names).toEqual(['get_weather'])
  })

  test('the session effort is clamped to what the model takes, as on the chat path', async () => {
    useProfile(OPENAI)
    const srv = await serve([toolLoop])

    // gpt-5.5-pro takes medium, high and xhigh: a session at low goes up to medium.
    const model = 'gpt-5.5-pro'
    await create({ model, system: SYSTEM, messages: [ASK], tools: [WEATHER_TOOL], stream: false, effortValue: 'low' })

    const levels = resolveShimEffortValues(OPENAI.baseUrl, model)!
    expect(levels).not.toContain('low')
    expect((srv.captures[0]!.json as Record<string, any>).reasoning.effort).toBe(clampEffortToValues('low', levels))
  })

  test('a keep-alive ping goes as it is: its max_tokens becomes the output floor', async () => {
    useProfile(OPENAI)
    const client = await getAnthropicClient({ maxRetries: 0, model: 'gpt-5.5' })
    const messages = client.beta.messages as unknown as { keepAlivePingParams(p: Record<string, unknown>): unknown }
    const params = { model: 'gpt-5.5', max_tokens: 1, messages: [] }
    expect(messages.keepAlivePingParams(params)).toBe(params)
  })
})

describe('Azure OpenAI v1', () => {
  test('the key goes as api-key and the URL carries api-version=v1, as recorded', async () => {
    useProfile(AZURE)
    const recorded = loadCassette('azure/responses-streams-text')
    const srv = await serve([recorded])

    await create({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'Say hello.' }], stream: false })

    const sent = srv.captures[0]!
    expect(sent.path).toBe('/openai/v1/responses')
    expect(sent.search).toBe('?api-version=v1')
    expect(sent.headers['api-key']).toBe('azure-key')
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.json).not.toHaveProperty('prompt_cache_key')
  })
})

describe('falling back to chat', () => {
  const chatAnswer = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'c',
      model: 'gpt-5.5',
      choices: [{ message: { role: 'assistant', content: 'from chat' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  }
  const cassette = (first: number): Cassette => ({
    version: 1,
    interactions: [
      { request: { method: 'POST', url: 'https://api.openai.com/v1/responses' }, response: { status: first, body: '{"error":{"message":"unsupported"}}' } },
      { request: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions' }, response: chatAnswer },
      { request: { method: 'POST', url: 'https://api.openai.com/v1/chat/completions' }, response: chatAnswer },
    ],
  })

  test('a 404 on the first request is answered over chat, and the next request goes straight there', async () => {
    useProfile(OPENAI)
    const srv = await serve([cassette(404)])

    const first = await create({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    const second = await create({ messages: [{ role: 'user', content: 'hi' }], stream: false })

    expect(first.content[0].text).toBe('from chat')
    expect(second.content[0].text).toBe('from chat')
    expect(srv.captures.map(c => c.path)).toEqual(['/v1/responses', '/v1/chat/completions', '/v1/chat/completions'])
    expect(resolveProviderRequest({ model: 'gpt-5.5' }).transport).toBe('chat_completions')
  })

  test('a 500 is not the wire\'s fault: it surfaces, and the pair stays on Responses', async () => {
    useProfile(OPENAI)
    await serve([cassette(500)])

    await expect(create({ messages: [{ role: 'user', content: 'hi' }], stream: false })).rejects.toThrow()
    expect(resolveProviderRequest({ model: 'gpt-5.5' }).transport).toBe('openai_responses')
  })

  test('a replayed reasoning item the host cannot decrypt is not a rejection of the wire', async () => {
    useProfile(OPENAI)
    await serve([
      {
        version: 1,
        interactions: [
          {
            request: { method: 'POST', url: 'https://api.openai.com/v1/responses' },
            response: { status: 400, body: '{"error":{"code":"invalid_encrypted_content","message":"could not decrypt"}}' },
          },
        ],
      },
    ])

    await expect(create({ messages: [{ role: 'user', content: 'hi' }], stream: false })).rejects.toThrow()
    expect(resolveProviderRequest({ model: 'gpt-5.5' }).transport).toBe('openai_responses')
  })
})
