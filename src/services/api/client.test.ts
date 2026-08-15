import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

type FetchType = typeof globalThis.fetch

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

type VertexClient = {
  messages: {
    create: (params: Record<string, unknown>) => Promise<unknown>
  }
}

// client.ts and openaiShim.ts both consume `tryGetActiveProvider()` for
// transport routing, baseUrl/apiKey resolution, and customHeaders. Spread the
// real module so other exports (getActiveProvider, ActiveProviderNotConfiguredError)
// remain shape-compatible, and restore in afterAll to avoid leaking the mock
// to subsequent test files.
const realActiveProvider = { ...(await import('src/services/api/activeProvider.js')) }
// Snapshot the real exports BEFORE registering the mock — Bun mutates the
// namespace object in place when mock.module installs, so the spread inside
// afterAll would otherwise pick up the mocked functions.
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = ReturnType<typeof realActiveProvider.getActiveProvider> | null

let resolvedOverride: ResolvedProvider = null

mock.module('./activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

afterAll(() => {
  mock.module('./activeProvider.js', () => realActiveProviderSnapshot)
})

const { getAnthropicClient } = await import('src/services/api/client.js')

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  CLAUDE_CODE_SKIP_VERTEX_AUTH: process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH,
  ANTHROPIC_VERTEX_PROJECT_ID: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  // The OpenAI shim still bridges the resolved profile into OPENAI_* slots
  // and the Gemini auth path checks GEMINI_AUTH_MODE for the api-key branch.
  process.env.GEMINI_AUTH_MODE = 'api-key'
  delete process.env.GEMINI_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH
  delete process.env.ANTHROPIC_VERTEX_PROJECT_ID
  resolvedOverride = null
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
  restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
  restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
  restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
  restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
  restoreEnv('ANTHROPIC_AUTH_TOKEN', originalEnv.ANTHROPIC_AUTH_TOKEN)
  restoreEnv('CLAUDE_CODE_SKIP_VERTEX_AUTH', originalEnv.CLAUDE_CODE_SKIP_VERTEX_AUTH)
  restoreEnv('ANTHROPIC_VERTEX_PROJECT_ID', originalEnv.ANTHROPIC_VERTEX_PROJECT_ID)
  globalThis.fetch = originalFetch
  resolvedOverride = null
})

test('routes Gemini provider requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  resolvedOverride = {
    transport: 'gemini',
    baseUrl: 'https://gemini.example/v1beta/openai',
    model: 'gemini-2.0-flash',
    apiKey: 'gemini-test-key',
    name: 'Gemini',
  }

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-gemini',
        model: 'gemini-2.0-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'gemini ok',
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

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gemini-2.0-flash',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'gemini-2.0-flash',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://gemini.example/v1beta/openai/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer gemini-test-key')
  expect(capturedBody?.model).toBe('gemini-2.0-flash')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gemini-2.0-flash',
  })
})

test('strips Anthropic-specific custom headers before sending OpenAI-compatible shim requests', async () => {
  let capturedHeaders: Headers | undefined

  resolvedOverride = {
    transport: 'openai_compat',
    baseUrl: 'http://example.test/v1',
    model: 'gpt-4o',
    apiKey: 'openai-test-key',
    name: 'OpenAI',
    extras: {
      customHeaders: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-anthropic-additional-protection': 'true',
        'x-claude-remote-session-id': 'remote-123',
        'x-app': 'cli',
        'x-safe-header': 'keep-me',
      },
    },
  }

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-openai',
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

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })) as unknown as ShimClient

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
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer openai-test-key')
})


// CLAUDE_CODE_SKIP_VERTEX_AUTH swaps a stub in for GoogleAuth so requests can be
// pointed at an auth-injecting proxy. @anthropic-ai/vertex-sdk calls
// `.get('x-goog-user-project')` on whatever `getRequestHeaders()` returns and then
// passes it to `buildHeaders()`, so the stub has to hand back a real `Headers`.
// While it returned a plain object every request under the escape hatch died with
// "googleAuthHeaders.get is not a function" before reaching the network.
test('CLAUDE_CODE_SKIP_VERTEX_AUTH stub returns Headers the Vertex SDK can read', async () => {
  let capturedUrl: string | undefined

  process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1'
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project'

  // Partial fixture on purpose: the Vertex branch only reads `transport`,
  // `model` and the optional `extras.gcp*`, and a fuller literal would just
  // add fields this path never touches.
  resolvedOverride = {
    transport: 'vertex',
    model: 'claude-sonnet-4-5',
  } as unknown as ResolvedProvider

  globalThis.fetch = (async input => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    return new Response(
      JSON.stringify({
        id: 'msg_vertex',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'vertex ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 3 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-5',
  })) as unknown as VertexClient

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  // Reaching a URL at all proves `.get()` resolved: the SDK reads the project id
  // off the auth headers on the line before it builds this path.
  expect(capturedUrl).toContain('/projects/test-project/locations/')
  expect(capturedUrl).toContain(':rawPredict')
  expect(response).toMatchObject({ role: 'assistant', model: 'claude-sonnet-4-5' })
})
