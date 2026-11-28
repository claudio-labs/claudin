// Client-side tool search on every wire that has no server-side tool search,
// through the client factory the agent loop uses: the Chat Completions shim,
// the Responses path (Copilot's GPT-5 here; Codex shares the converter) and
// native Gemini. The first-party Anthropic client is left alone.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { CALL_TOOL_NAME } from 'src/providers/shims/clientToolSearch/callTool.js'
import { getAnthropicClient } from 'src/providers/transport/client.js'

const g = globalThis as Record<string, unknown>
const savedMacro = g.MACRO
g.MACRO = { VERSION: '99.0.0', DISPLAY_VERSION: '0.0.0-test' }
const originalFetch = globalThis.fetch
const savedKillswitch = process.env.CLAUDIN_SHIM_TOOL_SEARCH
const savedApiKey = process.env.ANTHROPIC_API_KEY

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
const TOOLS = [BASH, TOOL_SEARCH, ENDPOINT_LIST]

const AFTER_DISCOVERY = [
  { role: 'user', content: 'lista os endpoints do portainer' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_t1', name: 'ToolSearch', input: { query: 'select:mcp__portainer__EndpointList' } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_t1', content: [{ type: 'tool_reference', tool_name: 'mcp__portainer__EndpointList' }] },
      { type: 'text', text: 'Tool loaded.' },
    ],
  },
]

const AFTER_CALL = [
  ...AFTER_DISCOVERY,
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_t2', name: 'mcp__portainer__EndpointList', input: { select: '[].Id' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_t2', content: '[1, 2]' }] },
]

const PROFILES: Record<string, ProviderProfile> = {
  chat: { id: 'o', name: 'compat', provider: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'qwen3-coder', apiKey: 'k' },
  copilot: {
    id: 'gh',
    name: 'copilot',
    provider: 'openai',
    baseUrl: 'https://api.githubcopilot.com',
    model: 'gpt-5.4',
    extras: { githubToken: 't' },
  },
  gemini: {
    id: 'g',
    name: 'gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3-pro',
    apiKey: 'k',
  },
  anthropic: { id: 'a', name: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'sk-ant-k' },
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({ ...current, providerProfiles: [profile], activeProviderProfileId: profile.id }))
  invalidateActiveProviderCache()
}

function sse(lines: string[]): Response {
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } })
}

const REPLIES: Record<string, () => Response> = {
  chat: () =>
    sse([
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  copilot: () =>
    sse([
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    ]),
  gemini: () =>
    sse([
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`,
    ]),
  anthropic: () =>
    sse([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]),
}

type Sent = { url: string; body: Record<string, any> }

async function send(kind: keyof typeof PROFILES, messages: unknown[]): Promise<Sent> {
  useProfile(PROFILES[kind]!)
  const sent: Sent[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined)
    sent.push({ url, body: JSON.parse(String(raw)) })
    return REPLIES[kind]!()
  }) as typeof globalThis.fetch
  const client = await getAnthropicClient({ maxRetries: 0, model: PROFILES[kind]!.model })
  const result = await client.beta.messages
    .create({ model: PROFILES[kind]!.model, max_tokens: 64, stream: true, tools: TOOLS, messages } as never)
    .withResponse()
  for await (const _ of result.data as AsyncIterable<unknown>) {
    // drain
  }
  expect(sent).toHaveLength(1)
  return sent[0]!
}

beforeEach(() => {
  delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  process.env.ANTHROPIC_API_KEY = 'sk-ant-k'
  resetGlobalConfigForTests()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (savedKillswitch === undefined) delete process.env.CLAUDIN_SHIM_TOOL_SEARCH
  else process.env.CLAUDIN_SHIM_TOOL_SEARCH = savedKillswitch
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedApiKey
  saveGlobalConfig(current => ({ ...current, providerProfiles: [], activeProviderProfileId: undefined }))
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
})

afterAll(() => {
  g.MACRO = savedMacro
})

describe('tools[] on each wire', () => {
  test('Chat Completions: the deferred tool stays behind the gateway', async () => {
    const { body } = await send('chat', AFTER_DISCOVERY)
    expect(body.tools.map((t: any) => t.function.name)).toEqual(['Bash', 'ToolSearch', CALL_TOOL_NAME])
  })

  test('Responses: the deferred tool stays behind the gateway, which goes out non-strict', async () => {
    const { body } = await send('copilot', AFTER_DISCOVERY)
    expect(body.tools.map((t: any) => t.name)).toEqual(['Bash', 'ToolSearch', CALL_TOOL_NAME])
    const gateway = body.tools.find((t: any) => t.name === CALL_TOOL_NAME)
    expect(gateway.strict).toBe(false)
    expect(Object.keys(gateway.parameters.properties)).toEqual(['name', 'arguments'])
  })

  test('Gemini: the deferred tool stays behind the gateway', async () => {
    const { body } = await send('gemini', AFTER_DISCOVERY)
    expect(body.tools[0].functionDeclarations.map((t: any) => t.name)).toEqual(['Bash', 'ToolSearch', CALL_TOOL_NAME])
  })

  test('first-party Anthropic: the request is not touched', async () => {
    const { body } = await send('anthropic', AFTER_DISCOVERY)
    expect(body.tools.map((t: any) => t.name)).toEqual(['Bash', 'ToolSearch', 'mcp__portainer__EndpointList'])
    expect(body.tools[2].defer_loading).toBe(true)
  })
})

describe('the ToolSearch result on each wire', () => {
  test('Responses: the loaded schema is the call output, not an empty string', async () => {
    const { body } = await send('copilot', AFTER_DISCOVERY)
    const output = body.input.find((i: any) => i.type === 'function_call_output' && i.call_id === 'call_t1')
    expect(output.output).toContain('<functions><function>')
    expect(output.output).toContain('"name":"mcp__portainer__EndpointList"')
  })

  test('Gemini: the loaded schema is the function response', async () => {
    const { body } = await send('gemini', AFTER_DISCOVERY)
    const response = body.contents
      .flatMap((c: any) => c.parts)
      .find((p: any) => p.functionResponse?.id === 'call_t1')
    expect(response.functionResponse.response.output).toContain('<functions><function>')
  })

  test('Responses: a deferred call in history goes back as a gateway call', async () => {
    const { body } = await send('copilot', AFTER_CALL)
    const call = body.input.find((i: any) => i.type === 'function_call' && i.call_id === 'call_t2')
    expect(call.name).toBe(CALL_TOOL_NAME)
    expect(JSON.parse(call.arguments)).toEqual({ name: 'mcp__portainer__EndpointList', arguments: { select: '[].Id' } })
  })

  test('the "Tool loaded." sibling is dropped once the result says Loaded.', async () => {
    const { body } = await send('copilot', AFTER_DISCOVERY)
    const userTexts = body.input
      .filter((i: any) => i.type === 'message' && i.role === 'user')
      .flatMap((i: any) => i.content.map((p: any) => p.text))
    expect(userTexts).not.toContain('Tool loaded.')
  })
})

describe('the killswitch', () => {
  test('CLAUDIN_SHIM_TOOL_SEARCH=0 sends every tool whole on Responses too', async () => {
    process.env.CLAUDIN_SHIM_TOOL_SEARCH = '0'
    const { body } = await send('copilot', AFTER_DISCOVERY)
    expect(body.tools.map((t: any) => t.name)).toEqual(['Bash', 'ToolSearch', 'mcp__portainer__EndpointList'])
  })
})
