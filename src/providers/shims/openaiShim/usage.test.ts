// Usage accounting: stream_options negotiation and the fallback token
// estimation for providers that report nothing.

import type Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'

import {
  createOpenAIShimClient,
  makeSseResponse,
  makeStreamChunks,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

test('preserves usage from final OpenAI stream chunk with empty choices', async () => {
  globalThis.fetch = (async (_input, init) => {
    const url =
      typeof _input === 'string'
        ? _input
        : _input instanceof URL
          ? _input.href
          : _input.url
    expect(url).toBe('http://example.test/v1/chat/completions')

    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBe(123)
  expect(usageEvent?.usage?.output_tokens).toBe(45)
})

test('local provider streaming does NOT send stream_options (uses fallback estimation)', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    // Local providers don't get stream_options to avoid 400 errors from
    // strict parsers (older llama.cpp server, etc.)
    expect(body.stream_options).toBeUndefined()
    expect(body.max_tokens).toBe(64)

    // Simulate provider that doesn't return usage
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  // Fallback should estimate non-zero input tokens
  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBeGreaterThan(0)
  expect(usageEvent?.usage?.output_tokens).toBeGreaterThan(0)
})

test('fallback estimates input tokens from system prompt', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'ok' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  // Test with a system prompt — its tokens should be included in the estimate
  const resultNoSystem = await client.beta.messages
    .create({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const eventsNoSystem: Array<Record<string, unknown>> = []
  for await (const event of resultNoSystem.data) {
    eventsNoSystem.push(event)
  }

  const usageNoSystem = eventsNoSystem.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number } } | undefined

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'ok' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-2',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const resultWithSystem = await client.beta.messages
    .create({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are a very detailed and verbose assistant that provides comprehensive answers.',
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const eventsWithSystem: Array<Record<string, unknown>> = []
  for await (const event of resultWithSystem.data) {
    eventsWithSystem.push(event)
  }

  const usageWithSystem = eventsWithSystem.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number } } | undefined

  // System prompt tokens should make the estimate significantly higher
  expect(usageWithSystem?.usage?.input_tokens).toBeGreaterThan(
    (usageNoSystem?.usage?.input_tokens ?? 0) + 5,
  )
})

test('fallback estimates input tokens from Claudin internal message format', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'response' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  // Use Claudin internal format: { type, message: { role, content } }
  const result = await client.beta.messages
    .create({
      model: 'llama3.1:8b',
      messages: [
        {
          type: 'user',
          message: { role: 'user', content: 'hello from internal format' },
        } as unknown as Anthropic.MessageParam,
      ],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number } } | undefined

  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBeGreaterThan(0)
})

test('cloud provider streaming sends stream_options.include_usage', async () => {
  // Non-local provider should get stream_options
  process.env.OPENAI_BASE_URL = undefined
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hi' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-4o',
        choices: [],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 2,
          total_tokens: 17,
        },
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBe(15)
  expect(usageEvent?.usage?.output_tokens).toBe(2)
})

test('fallback estimates input and output tokens when provider omits usage', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)

    // Simulate a provider that doesn't emit usage at all — no usage chunk
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world from local model' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'llama3.1:8b',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvent = events.find(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined

  // Fallback should estimate non-zero input tokens from the messages
  expect(usageEvent).toBeDefined()
  expect(usageEvent?.usage?.input_tokens).toBeGreaterThan(0)
  // Fallback should estimate non-zero output tokens from streamed chars
  expect(usageEvent?.usage?.output_tokens).toBeGreaterThan(0)
})
