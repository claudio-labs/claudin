// A vendor's own Anthropic endpoint for an openai_compat profile, against
// exchanges recorded from MiniMax, Moonshot and DashScope
// (src/providers/__fixtures__/cassettes/). The recorded host is swapped for
// the local cassette server at the fetch boundary, so routing and the SDK's
// URL and auth run as they do against the vendor.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import {
  activeTransportUsesOpenAiShim,
  getAPIProvider,
  usesNativeAnthropicWire,
} from 'src/providers/model/providers.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { _resetWireFallbackForTesting } from 'src/providers/presets/wireFallback.js'
import { getPromptCachingEnabled } from 'src/providers/shims/claude/paramBuilders.js'
import { CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/callTool.js'
import { vendorParams } from 'src/providers/shims/vendorAnthropic/client.js'
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
const ENVS = ['CLAUDIN_VENDOR_ANTHROPIC_WIRE', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDIN_SHIM_TOOL_SEARCH'] as const
const savedEnv = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))

let server: CassetteServer | undefined

const MINIMAX: ProviderProfile = {
  id: 'minimax',
  name: 'MiniMax',
  provider: 'openai',
  baseUrl: 'https://api.minimax.io/v1',
  model: 'MiniMax-M3',
  apiKey: 'mm-key',
}
const MOONSHOT: ProviderProfile = {
  id: 'moonshot',
  name: 'Moonshot',
  provider: 'openai',
  baseUrl: 'https://api.moonshot.ai/v1',
  model: 'kimi-k3',
  apiKey: 'ms-key',
}
const DASHSCOPE: ProviderProfile = {
  id: 'dashscope',
  name: 'DashScope',
  provider: 'openai',
  baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-max',
  apiKey: 'ds-key',
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
  invalidateActiveProviderCache()
}

async function serve(cassettes: Cassette[]): Promise<CassetteServer> {
  server = await startCassetteServer(cassettes)
  const target = new URL(server.url)
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const url = new URL(raw)
    url.protocol = target.protocol
    url.host = target.host
    if (input instanceof Request) return originalFetch(new Request(url, input), init)
    return originalFetch(url, init)
  }) as typeof globalThis.fetch
  return server
}

async function stream(profile: ProviderProfile, params: Record<string, unknown>): Promise<any[]> {
  const client = await getAnthropicClient({ maxRetries: 0, model: profile.model })
  const result = await client.beta.messages
    .create({ model: profile.model, max_tokens: 256, stream: true, ...params } as never)
    .withResponse()
  const events: any[] = []
  for await (const event of result.data as unknown as AsyncIterable<any>) events.push(event)
  return events
}

/** The content blocks a stream of events builds, as the agent loop keeps them. */
function blocksOf(events: any[]): any[] {
  const blocks: any[] = []
  for (const event of events) {
    if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block }
    if (event.type === 'content_block_delta') {
      const block = blocks[event.index]
      const delta = event.delta
      if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text
      if (delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking
      if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature
      if (delta.type === 'input_json_delta') block.json = (block.json ?? '') + delta.partial_json
    }
  }
  return blocks.map(block => {
    if (block.type !== 'tool_use') return block
    const { json, ...rest } = block
    return { ...rest, input: json ? JSON.parse(json) : {} }
  })
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

describe('which requests take the vendor endpoint', () => {
  test('the recorded hosts and their models; the profile keeps its provider tag', () => {
    for (const profile of [MINIMAX, MOONSHOT, DASHSCOPE]) {
      useProfile(profile)
      expect(usesNativeAnthropicWire()).toBe(true)
      expect(activeTransportUsesOpenAiShim()).toBe(false)
      expect(getPromptCachingEnabled(profile.model)).toBe(true)
    }
    useProfile(MINIMAX)
    expect(getAPIProvider()).toBe('minimax')
    expect(usesNativeAnthropicWire('abab6.5s-chat')).toBe(false)
  })

  test('the Alibaba coding plan, Z.ai and DeepSeek are unverified: chat unless all', () => {
    const unverified: ProviderProfile[] = [
      { ...DASHSCOPE, id: 'plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1', model: 'qwen3.6-plus' },
      { ...MINIMAX, id: 'zai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.2' },
      { ...MINIMAX, id: 'ds', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
    ]
    for (const profile of unverified) {
      useProfile(profile)
      expect(usesNativeAnthropicWire()).toBe(false)
    }
    process.env.CLAUDIN_VENDOR_ANTHROPIC_WIRE = 'all'
    for (const profile of unverified) {
      useProfile(profile)
      expect(usesNativeAnthropicWire()).toBe(true)
    }
  })

  test('CLAUDIN_VENDOR_ANTHROPIC_WIRE=0 and Kimi Code stay on chat', () => {
    process.env.CLAUDIN_VENDOR_ANTHROPIC_WIRE = '0'
    useProfile(MINIMAX)
    expect(usesNativeAnthropicWire()).toBe(false)
    delete process.env.CLAUDIN_VENDOR_ANTHROPIC_WIRE
    useProfile({ ...MOONSHOT, id: 'kimi-code', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding' })
    expect(usesNativeAnthropicWire()).toBe(false)
  })
})

describe('vendorParams', () => {
  test('metadata goes, and every beta but interleaved thinking', () => {
    expect(
      vendorParams({
        model: 'm',
        metadata: { user_id: '{"device_id":"d"}' },
        betas: ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'advanced-tool-use-2025-11-20'],
      }),
    ).toEqual({ model: 'm', betas: ['interleaved-thinking-2025-05-14'] })
    expect(vendorParams({ model: 'm', betas: ['claude-code-20250219'] })).toEqual({ model: 'm' })
  })
})

describe('the vendor endpoints, from the recordings', () => {
  test('MiniMax: /anthropic/v1/messages, the key as a bearer, no metadata, Claude betas cut, thinking read', async () => {
    useProfile(MINIMAX)
    const recorded = loadCassette('minimax-messages/m3-streams-adaptive-thinking')
    const srv = await serve([recorded])

    const events = await stream(MINIMAX, {
      messages: recordedRequestBody(recorded).messages,
      metadata: { user_id: '{"device_id":"secret"}' },
      betas: ['claude-code-20250219'],
    })

    const sent = srv.captures[0]!
    expect(sent.path).toBe('/anthropic/v1/messages')
    expect(sent.headers.authorization).toBe('Bearer mm-key')
    expect(sent.headers['x-api-key']).toBeUndefined()
    expect(sent.headers['anthropic-beta']).toBeUndefined()
    expect(sent.json).not.toHaveProperty('metadata')
    expect(blocksOf(events).map(block => block.type)).toEqual(['thinking', 'text'])
  })

  test('Moonshot: a tool loop sends the thinking back as the vendor wrote it', async () => {
    useProfile(MOONSHOT)
    const recorded = loadCassette('moonshot-messages/kimi-k3-preserves-reasoning-through-a-tool-loop-and-follow-up')
    const srv = await serve([recorded])
    const first = recordedRequestBody(recorded, 0)

    const turn = blocksOf(await stream(MOONSHOT, { messages: first.messages, tools: first.tools }))
    const call = turn.find(block => block.type === 'tool_use')
    expect(call).toBeDefined()
    await stream(MOONSHOT, {
      tools: first.tools,
      messages: [
        ...(first.messages as unknown[]),
        { role: 'assistant', content: turn },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'sunny' }] },
      ],
    })

    const replayed = (srv.captures[1]!.json as Record<string, any>).messages.at(-2)
    expect(replayed.role).toBe('assistant')
    expect(replayed.content.map((block: any) => block.type)).toEqual(turn.map(block => block.type))
    expect(replayed.content[0]).toMatchObject({ type: 'thinking', thinking: turn[0].thinking })
    expect(srv.unmatched).toHaveLength(0)
  })

  test('DashScope: the Qwen answer and its signed thinking are read', async () => {
    useProfile(DASHSCOPE)
    const recorded = loadCassette('alibaba-messages/qwen-3-8-max-streams-default-effort')
    const srv = await serve([recorded])

    const blocks = blocksOf(await stream(DASHSCOPE, { messages: recordedRequestBody(recorded).messages }))

    expect(srv.captures[0]!.path).toBe('/apps/anthropic/v1/messages')
    expect(blocks[0]).toMatchObject({ type: 'thinking' })
    expect(typeof blocks[0].signature).toBe('string')
    expect(blocks.some(block => block.type === 'text' && block.text.length > 0)).toBe(true)
  })

  test('the client pings no keep-alive and counts no tokens', async () => {
    useProfile(MINIMAX)
    const client = await getAnthropicClient({ maxRetries: 0, model: MINIMAX.model })
    const messages = client.beta.messages as unknown as Record<string, unknown> & {
      keepAlivePingParams(params: Record<string, unknown>): unknown
    }
    expect(messages.keepAlivePingParams({ model: 'm' })).toBeNull()
    expect(typeof messages.countTokens).toBe('undefined')
    expect('countTokens' in messages).toBe(false)
  })

  test('tool search runs in front of it: deferred tools leave, CallTool joins', async () => {
    useProfile(MINIMAX)
    const recorded = loadCassette('minimax-messages/m3-streams-adaptive-thinking')
    const srv = await serve([recorded])

    await stream(MINIMAX, {
      messages: recordedRequestBody(recorded).messages,
      tools: [
        { name: 'Bash', input_schema: { type: 'object', properties: {} } },
        { name: 'mcp__a', input_schema: { type: 'object', properties: {} }, defer_loading: true },
      ],
    })

    const tools = (srv.captures[0]!.json as Record<string, any>).tools
    expect(tools.map((tool: any) => tool.name)).toEqual(['Bash', CALL_TOOL_NAME])
    expect(tools.some((tool: any) => 'defer_loading' in tool)).toBe(false)
  })
})

describe('falling back to chat', () => {
  const chatAnswer = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'c',
      model: 'MiniMax-M3',
      choices: [{ message: { role: 'assistant', content: 'from chat' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  }

  test('a 404 on the first request is answered over chat, and the next request goes straight there', async () => {
    useProfile(MINIMAX)
    const srv = await serve([
      {
        version: 1,
        interactions: [
          {
            request: { method: 'POST', url: 'https://api.minimax.io/anthropic/v1/messages' },
            response: { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"type":"not_found_error","message":"no"}}' },
          },
          { request: { method: 'POST', url: 'https://api.minimax.io/v1/chat/completions' }, response: chatAnswer },
          { request: { method: 'POST', url: 'https://api.minimax.io/v1/chat/completions' }, response: chatAnswer },
        ],
      },
    ])
    const client = await getAnthropicClient({ maxRetries: 0, model: MINIMAX.model })
    const ask = () =>
      client.beta.messages.create({
        model: MINIMAX.model,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      } as never) as Promise<any>

    expect((await ask()).content[0].text).toBe('from chat')
    expect((await ask()).content[0].text).toBe('from chat')
    expect(srv.captures.map(capture => capture.path)).toEqual([
      '/anthropic/v1/messages',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ])
  })

  test('a 529 is not the wire\'s fault: it surfaces', async () => {
    useProfile(MINIMAX)
    await serve([
      {
        version: 1,
        interactions: [
          {
            request: { method: 'POST', url: 'https://api.minimax.io/anthropic/v1/messages' },
            response: { status: 529, headers: { 'content-type': 'application/json' }, body: '{"error":{"type":"overloaded_error"}}' },
          },
        ],
      },
    ])
    const client = await getAnthropicClient({ maxRetries: 0, model: MINIMAX.model })
    await expect(
      client.beta.messages.create({ model: MINIMAX.model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } as never),
    ).rejects.toThrow()
    expect(usesNativeAnthropicWire()).toBe(true)
  })
})
