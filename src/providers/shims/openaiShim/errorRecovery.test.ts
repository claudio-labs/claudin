// Error recovery: classifying transport failures into actionable categories and
// the self-healing retries for local endpoints.

import { expect, test } from 'bun:test'

import {
  getAssistantMessageFromError,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from 'src/providers/transport/errors.js'
import {
  createOpenAIShimClient,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

test('classifies localhost transport failures with actionable category marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  globalThis.fetch = (async () => {
    throw transportError
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('local server is running')
})

test('propagates AbortError without wrapping it as transport failure', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  globalThis.fetch = (async () => {
    throw abortError
  }) as unknown as FetchType

  const controller = new AbortController()
  controller.abort()

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create(
      {
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(abortError)
})

test('classifies chat-completions endpoint 404 failures with endpoint_not_found marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  globalThis.fetch = (async () =>
    new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
      },
    })) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=endpoint_not_found')
})
// Most OpenAI-compatible servers answer an error with a JSON body. The SDK
// builds the error's message from that body when it is handed one, which
// dropped the category marker and the hint the shim wrote.
test('keeps the category marker when the error body is JSON', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "This model's maximum context length is 8192 tokens.",
          code: 'context_length_exceeded',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=context_overflow')
})

// The compaction retry keys on PROMPT_TOO_LONG_ERROR_MESSAGE; an overflow from
// an OpenAI-compatible server has to read as the same thing or /compact on a
// local model fails instead of trimming and retrying.
for (const [label, body] of [
  ['an OpenAI-style overflow', "This model's maximum context length is 8192 tokens."],
  ['a llama.cpp overflow', 'the request exceeds the available context size, try increasing it'],
  ['a vLLM overflow', 'This model has a maximum context window of 4096 tokens. Please reduce the length of the messages.'],
] as const) {
  test(`${label} becomes the prompt-too-long message`, async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'

    globalThis.fetch = (async () =>
      new Response(body, {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      })) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const error = await client.beta.messages
      .create({
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      )

    const message = getAssistantMessageFromError(error, 'qwen2.5-coder:7b')
    const content = message.message.content as Array<{ text?: string }>
    expect(content[0]?.text).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE)
  })
}

// Bedrock answers a throttle with "Too many tokens, please wait"; that is a
// rate limit, not a context overflow.
test('a "too many tokens, please wait" throttle is not an overflow', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1'

  globalThis.fetch = (async () =>
    new Response('Too many tokens, please wait before trying again.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.not.toThrow('openai_category=context_overflow')
})

// A gateway that throttles with a 403 is told apart from a bad key only by a
// structured signal: Retry-After, or a rate-limit code/type in the JSON error.
// Prose alone is not enough — "rate limit" also appears in auth refusals.
test('classifies a 403 carrying a rate-limit code as rate_limited', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=rate_limited')
})

test('classifies a 403 with Retry-After as rate_limited', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'

  globalThis.fetch = (async () =>
    new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain', 'Retry-After': '1' },
    })) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=rate_limited')
})

test('a 403 that only says "rate limit" in prose stays auth_invalid', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.example.com/v1'

  globalThis.fetch = (async () =>
    new Response('API key not allowed: rate limit tier missing', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=auth_invalid')
})

test('self-heals localhost resolution failures by retrying local loopback base URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    requestUrls.push(url)

    if (url.includes('localhost')) {
      const error = Object.assign(new TypeError('fetch failed'), {
        code: 'ENOTFOUND',
      })
      throw error
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello from loopback',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestUrls[0]).toBe('http://localhost:11434/v1/chat/completions')
  expect(requestUrls).toContain('http://127.0.0.1:11434/v1/chat/completions')
})

test('self-heals local endpoint_not_found by retrying with /v1 base URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    requestUrls.push(url)

    if (url === 'http://localhost:11434/chat/completions') {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello from /v1',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestUrls).toEqual([
    'http://localhost:11434/chat/completions',
    'http://localhost:11434/v1/chat/completions',
  ])
})

test('self-heals tool-call incompatibility by retrying local Ollama requests without tools', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestBodies.push(requestBody)

    if (requestBodies.length === 1) {
      return new Response('tool_calls are not supported', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'fallback without tools',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
          },
        },
      ],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestBodies).toHaveLength(2)
  expect(Array.isArray(requestBodies[0]?.tools)).toBe(true)
  expect(requestBodies[0]?.tool_choice).toBeUndefined()
  expect(
    requestBodies[1]?.tools === undefined ||
      (Array.isArray(requestBodies[1]?.tools) && requestBodies[1]?.tools.length === 0),
  ).toBe(true)
  expect(requestBodies[1]?.tool_choice).toBeUndefined()
})
