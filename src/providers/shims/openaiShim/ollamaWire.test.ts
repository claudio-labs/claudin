// What the shim sends to, and reads back from, a local Ollama server: real
// usage with its KV-cache split, the Modelfile's sampling, thinking on/off,
// and an idle timeout long enough for a slow prefill.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  makeSseResponse,
  makeStreamChunks,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'
import { _resetOllamaModelInfoForTesting } from 'src/providers/model/ollamaModelInfo.js'

useShimHarness()

const OLLAMA = 'http://localhost:11434/v1'
const QWEN = 'mgraffam/qwen3.8-35B-A3B-empero:latest'

type ShowPayload = {
  capabilities?: string[]
  parameters?: string
  details?: { family?: string }
}

const QWEN_SHOW: ShowPayload = {
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
  parameters: 'top_k 20\ntop_p 0.95\nnum_ctx 262144\ntemperature 0.6',
  details: { family: 'qwen35moe' },
}

const GPT_OSS_SHOW: ShowPayload = {
  capabilities: ['completion', 'tools', 'thinking'],
  parameters: 'temperature 1',
  details: { family: 'gptoss' },
}

let savedApiTimeout: string | undefined

beforeEach(() => {
  savedApiTimeout = process.env.API_TIMEOUT_MS
  delete process.env.API_TIMEOUT_MS
  _resetOllamaModelInfoForTesting()
})

afterEach(() => {
  if (savedApiTimeout === undefined) delete process.env.API_TIMEOUT_MS
  else process.env.API_TIMEOUT_MS = savedApiTimeout
  _resetOllamaModelInfoForTesting()
})

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request).url
}

/** A fake Ollama: answers /api/show and /api/ps, records chat bodies and inits. */
function fakeOllama(opts: {
  show?: ShowPayload
  usage?: Record<string, unknown>
  captured: Array<{ body: Record<string, unknown>; init: RequestInit & { timeout?: unknown } }>
}): FetchType {
  return (async (input, init) => {
    const url = urlOf(input)
    if (url.endsWith('/api/show')) {
      return Response.json(opts.show ?? {})
    }
    if (url.endsWith('/api/ps')) {
      return Response.json({ models: [] })
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    opts.captured.push({ body, init: init as RequestInit & { timeout?: unknown } })
    return makeSseResponse(
      makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: String(body.model),
          choices: [{ index: 0, delta: { role: 'assistant', content: 'oi' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: String(body.model),
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        ...(opts.usage
          ? [{ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: String(body.model), choices: [], usage: opts.usage }]
          : []),
      ]),
    )
  }) as FetchType
}

async function send(params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({ messages: [{ role: 'user', content: 'ola esta ai' }], max_tokens: 64, stream: true, ...params })
    .withResponse()
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) events.push(event)
  return events
}

function finalUsage(events: Array<Record<string, unknown>>): Record<string, number> | undefined {
  const delta = events.findLast(
    e => e.type === 'message_delta' && typeof e.usage === 'object' && e.usage !== null,
  ) as { usage?: Record<string, number> } | undefined
  return delta?.usage
}

describe('usage', () => {
  test('asks Ollama for usage — it reports prompt and cached tokens', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN })

    expect(captured[0]?.body.stream_options).toEqual({ include_usage: true })
  })

  test('maps Ollama usage onto the KV cache: prefill is a write, the reused prefix a read', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({
      show: QWEN_SHOW,
      captured,
      usage: { prompt_tokens: 178, prompt_tokens_details: { cached_tokens: 174 }, completion_tokens: 28, total_tokens: 206 },
    })

    const usage = finalUsage(await send({ model: QWEN }))

    expect(usage?.input_tokens).toBe(0)
    expect(usage?.cache_creation_input_tokens).toBe(4)
    expect(usage?.cache_read_input_tokens).toBe(174)
    expect(usage?.output_tokens).toBe(28)
  })

  test('another local server keeps #13: no stream_options', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ captured })

    await send({ model: 'llama3.1:8b' })

    expect(captured[0]?.body.stream_options).toBeUndefined()
  })

  test('the fallback estimate counts the tools the request carried', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ captured })
    const bigTool = {
      name: 'mcp__portainer__SettingsUpdate',
      description: 'Update settings. '.repeat(1500),
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    }

    const usage = finalUsage(await send({ model: 'llama3.1:8b', tools: [bigTool] }))

    // ~25k characters of tool schema alone; messages are a handful of tokens.
    expect(usage?.input_tokens ?? 0).toBeGreaterThan(5000)
  })
})

describe('sampling from the Modelfile', () => {
  test('sends the Modelfile temperature and top_p so /v1 does not force 1.0', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN })

    expect(captured[0]?.body.temperature).toBe(0.6)
    expect(captured[0]?.body.top_p).toBe(0.95)
  })

  test('Claudin\'s default temperature of 1 yields to the Modelfile', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN, temperature: 1 })

    expect(captured[0]?.body.temperature).toBe(0.6)
  })

  test('an explicit temperature other than the default is kept', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN, temperature: 0 })

    expect(captured[0]?.body.temperature).toBe(0)
  })
})

describe('thinking', () => {
  test('thinking disabled turns the model\'s thinking off on the wire', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN, thinking: { type: 'disabled' } })

    expect(captured[0]?.body.reasoning_effort).toBe('none')
  })

  test('thinking on with an on/off model sends nothing — the server thinks by default', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN, thinking: { type: 'adaptive' } })

    expect(captured[0]?.body.reasoning_effort).toBeUndefined()
  })

  test('a model with real levels (gpt-oss) gets the chosen effort', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: GPT_OSS_SHOW, captured })

    await send({ model: 'gpt-oss:20b', thinking: { type: 'adaptive' }, effortValue: 'high' })

    expect(captured[0]?.body.reasoning_effort).toBe('high')
  })

  test('a model without the thinking capability never gets reasoning_effort', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: { capabilities: ['completion', 'tools'] }, captured })

    await send({ model: 'llama3.1:8b', thinking: { type: 'disabled' } })

    expect(captured[0]?.body.reasoning_effort).toBeUndefined()
  })
})

describe('idle timeout', () => {
  test('a local server waits 30 minutes for the first byte', async () => {
    process.env.OPENAI_BASE_URL = OLLAMA
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ show: QWEN_SHOW, captured })

    await send({ model: QWEN })

    expect(captured[0]?.init.timeout).toBe(30 * 60 * 1000)
  })

  test('a hosted endpoint waits API_TIMEOUT_MS\'s default, 600 s', async () => {
    process.env.OPENAI_BASE_URL = 'https://llm.example.test/v1'
    const captured: Parameters<typeof fakeOllama>[0]['captured'] = []
    globalThis.fetch = fakeOllama({ captured })

    await send({ model: 'some-model' })

    expect(captured[0]?.init.timeout).toBe(600_000)
  })
})
