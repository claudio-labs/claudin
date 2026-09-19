// Wire-identity: which headers the shim strips, forwards or invents, and the
// per-endpoint cache/session hints that ride alongside them.

import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  getSessionId,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

test('strips canonical Anthropic headers from direct shim defaultHeaders', async () => {
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({
    defaultHeaders: {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-anthropic-additional-protection': 'true',
      'x-claude-remote-session-id': 'remote-123',
      'x-app': 'cli',
      'x-client-app': 'sdk',
      'x-safe-header': 'keep-me',
    },
  }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-anthropic-additional-protection')).toBeNull()
  expect(capturedHeaders?.get('x-claude-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-app')).toBeNull()
  expect(capturedHeaders?.get('x-client-app')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
})

test('strips canonical Anthropic headers from per-request shim headers too', async () => {
  let capturedHeaders: Headers | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create(
    {
      model: 'gpt-4o',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    },
    {
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-safe-header': 'keep-me',
      },
    },
  )

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
})

test('strips Anthropic-specific headers on GitHub Codex transport requests', async () => {
  let capturedHeaders: Headers | undefined

  process.env.CLAUDIN_USE_GITHUB = '1'
  process.env.OPENAI_API_KEY = 'github-test-key'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response('', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    })
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create(
    {
      model: 'github:gpt-5-codex',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    {
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-anthropic-additional-protection': 'true',
        'x-safe-header': 'keep-me',
      },
    },
  )

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-anthropic-additional-protection')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer github-test-key')
  expect(capturedHeaders?.get('editor-plugin-version')).toBe('copilot-chat/0.26.7')
})

test('sends prompt_cache_key + retention to api.openai.com only', async () => {
  const capturedBodies: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (_input, init) => {
    capturedBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  // Official OpenAI URL → params present
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  const officialClient = createOpenAIShimClient({}) as OpenAIShimClient
  await officialClient.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedBodies[0]?.prompt_cache_key).toBe(getSessionId())
  expect(capturedBodies[0]?.prompt_cache_retention).toBe('24h')

  // Non-official URL (beforeEach default http://example.test/v1) → withheld
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  const otherClient = createOpenAIShimClient({}) as OpenAIShimClient
  await otherClient.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedBodies[1]?.prompt_cache_key).toBeUndefined()
  expect(capturedBodies[1]?.prompt_cache_retention).toBeUndefined()
})

test('sends x-grok-conv-id to api.x.ai only, never in the body', async () => {
  const capturedHeaders: Headers[] = []
  const capturedBodies: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders.push(new Headers(init?.headers))
    capturedBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'grok-4.6',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const send = async (baseUrl: string): Promise<void> => {
    process.env.OPENAI_BASE_URL = baseUrl
    const client = createOpenAIShimClient({}) as OpenAIShimClient
    await client.beta.messages.create({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  }

  // xAI → header present, and the routing key never rides the body (xAI
  // documents prompt_cache_key for its Responses endpoint only).
  await send('https://api.x.ai/v1')
  expect(capturedHeaders[0]?.get('x-grok-conv-id')).toBe(getSessionId())
  expect(capturedBodies[0]?.prompt_cache_key).toBeUndefined()

  // Every other backend is untouched — a generic OpenAI-compatible URL, the
  // official OpenAI lane, and a lookalike host the exact-host gate must reject.
  await send('http://example.test/v1')
  expect(capturedHeaders[1]?.get('x-grok-conv-id')).toBeNull()

  await send('https://api.openai.com/v1')
  expect(capturedHeaders[2]?.get('x-grok-conv-id')).toBeNull()

  await send('https://evil.api.x.ai/v1')
  expect(capturedHeaders[3]?.get('x-grok-conv-id')).toBeNull()

  process.env.CLAUDIN_DISABLE_XAI_CONV_ID = '1'
  await send('https://api.x.ai/v1')
  expect(capturedHeaders[4]?.get('x-grok-conv-id')).toBeNull()
})

test('sends x-opencode-session to opencode.ai/zen (zen and go lanes) only', async () => {
  const capturedHeaders: Headers[] = []

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders.push(new Headers(init?.headers))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.3',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const send = async (baseUrl: string): Promise<void> => {
    process.env.OPENAI_BASE_URL = baseUrl
    const client = createOpenAIShimClient({}) as OpenAIShimClient
    await client.beta.messages.create({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  }

  // OpenCode Zen lane → header present, carrying the session-stable id
  // (the gateway uses it for routing + prompt caching).
  await send('https://opencode.ai/zen/v1')
  expect(capturedHeaders[0]?.get('x-opencode-session')).toBe(getSessionId())

  // OpenCode GO lane → same header, same stable id (same gateway).
  await send('https://opencode.ai/zen/go/v1')
  expect(capturedHeaders[1]?.get('x-opencode-session')).toBe(getSessionId())

  // Every other backend is untouched — a generic OpenAI-compatible URL,
  // a non-/zen path on opencode.ai, and a lookalike host the exact-host
  // gate must reject.
  await send('http://example.test/v1')
  expect(capturedHeaders[2]?.get('x-opencode-session')).toBeNull()

  await send('https://opencode.ai/api/v1')
  expect(capturedHeaders[3]?.get('x-opencode-session')).toBeNull()

  await send('https://evil-opencode.ai/zen/v1')
  expect(capturedHeaders[4]?.get('x-opencode-session')).toBeNull()

  process.env.CLAUDIN_DISABLE_OPENCODE_SESSION_ID = '1'
  await send('https://opencode.ai/zen/v1')
  expect(capturedHeaders[5]?.get('x-opencode-session')).toBeNull()
})
