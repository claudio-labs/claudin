import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

type CapturedRequest = { url: string; headers: Headers; body: string }

const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'client-test-'))
process.env.CLAUDIN_CONFIG_DIR = configDir

// client.ts and openaiShim.ts both consume `tryGetActiveProvider()` for
// transport routing, baseUrl/apiKey resolution, and customHeaders. Spread the
// real module so other exports (getActiveProvider, ActiveProviderNotConfiguredError)
// remain shape-compatible, and restore in afterAll to avoid leaking the mock
// to subsequent test files.
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }
// Snapshot the real exports BEFORE registering the mock — Bun mutates the
// namespace object in place when mock.module installs, so the spread inside
// afterAll would otherwise pick up the mocked functions.
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = ReturnType<typeof realActiveProvider.getActiveProvider> | null

let resolvedOverride: ResolvedProvider = null

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

afterAll(() => {
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProviderSnapshot)
})

const { getAnthropicClient } = await import('src/providers/transport/client.js')
const auth = await import('src/providers/auth/auth.js')
const debug = await import('src/shared/debug.js')

let subscriber = false
let oauthAccessToken: string | null = null
let configApiKey: string | null = 'sk-config-key'
let helperKey: string | null = null
let awsCredentials: {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null = null
let debugToStdErr = false
let oauthChecks = 0
let awsRefreshes = 0
let gcpRefreshes = 0
const spies: Array<{ mockRestore: () => void }> = []

beforeAll(() => {
  spies.push(
    spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockImplementation(async () => {
      oauthChecks++
      return false
    }),
    spyOn(auth, 'isClaudeAISubscriber').mockImplementation(() => subscriber),
    spyOn(auth, 'getClaudeAIOAuthTokens').mockImplementation(
      (() =>
        oauthAccessToken === null
          ? null
          : {
              accessToken: oauthAccessToken,
              refreshToken: null,
              expiresAt: null,
              scopes: ['user:inference'],
              subscriptionType: null,
              rateLimitTier: null,
            }) as unknown as typeof auth.getClaudeAIOAuthTokens,
    ),
    spyOn(auth, 'getAnthropicApiKey').mockImplementation(() => configApiKey),
    spyOn(auth, 'getApiKeyFromApiKeyHelper').mockImplementation(async () => helperKey),
    spyOn(auth, 'refreshAndGetAwsCredentials').mockImplementation((async () => {
      awsRefreshes++
      return awsCredentials
    }) as unknown as typeof auth.refreshAndGetAwsCredentials),
    spyOn(auth, 'refreshGcpCredentialsIfNeeded').mockImplementation((async () => {
      gcpRefreshes++
      return false
    }) as unknown as typeof auth.refreshGcpCredentialsIfNeeded),
    spyOn(debug, 'isDebugToStdErr').mockImplementation(
      (() => debugToStdErr) as unknown as typeof debug.isDebugToStdErr,
    ),
  )
})

afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  restoreEnv('CLAUDIN_CONFIG_DIR', savedConfigDir)
  rmSync(configDir, { recursive: true, force: true })
})

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const ENV_KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDIN_SKIP_VERTEX_AUTH',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDIN_ADDITIONAL_PROTECTION',
  'CLAUDIN_SKIP_BEDROCK_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDIN_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLOUD_ML_REGION',
  'VERTEX_REGION_CLAUDE_4_6_SONNET',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const
const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  for (const key of ENV_KEYS) delete process.env[key]
  // The OpenAI shim still bridges the resolved profile into OPENAI_* slots
  // and the Gemini auth path checks GEMINI_AUTH_MODE for the api-key branch.
  process.env.GEMINI_AUTH_MODE = 'api-key'
  resolvedOverride = null
  subscriber = false
  oauthAccessToken = null
  configApiKey = 'sk-config-key'
  helperKey = null
  awsCredentials = null
  debugToStdErr = false
  oauthChecks = 0
  awsRefreshes = 0
  gcpRefreshes = 0
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
  for (const key of ENV_KEYS) restoreEnv(key, originalEnv[key])
  globalThis.fetch = originalFetch
  resolvedOverride = null
})

const MESSAGE_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 3 },
}

function captureFetch(requests: CapturedRequest[]): FetchType {
  return (async (input, init) => {
    const request = input instanceof Request ? input : undefined
    requests.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      headers: new Headers(init?.headers ?? request?.headers),
      body: String(init?.body ?? ''),
    })
    return new Response(JSON.stringify(MESSAGE_RESPONSE), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as FetchType
}

async function sendOne(
  options: Parameters<typeof getAnthropicClient>[0] = { maxRetries: 0 },
): Promise<CapturedRequest> {
  const requests: CapturedRequest[] = []
  globalThis.fetch = captureFetch(requests)
  const client = (await getAnthropicClient(options)) as unknown as VertexClient
  await client.messages.create({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
  })
  expect(requests).toHaveLength(1)
  return requests[0]!
}

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


// CLAUDIN_SKIP_VERTEX_AUTH swaps a stub in for GoogleAuth so requests can be
// pointed at an auth-injecting proxy. @anthropic-ai/vertex-sdk calls
// `.get('x-goog-user-project')` on whatever `getRequestHeaders()` returns and then
// passes it to `buildHeaders()`, so the stub has to hand back a real `Headers`.
// While it returned a plain object every request under the escape hatch died with
// "googleAuthHeaders.get is not a function" before reaching the network.
test('CLAUDIN_SKIP_VERTEX_AUTH stub returns Headers the Vertex SDK can read', async () => {
  let capturedUrl: string | undefined

  process.env.CLAUDIN_SKIP_VERTEX_AUTH = '1'
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

describe('first-party Anthropic lane', () => {
  test('sends the configured API key with the first-party identity', async () => {
    const request = await sendOne()

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers.get('x-api-key')).toBe('sk-config-key')
    expect(request.headers.get('authorization')).toBeNull()
    expect(request.headers.get('x-app')).toBe('cli')
    expect(request.headers.get('x-claude-code-session-id')).toBeTruthy()
    expect(request.headers.get('x-claudin-session-id')).toBeNull()
    expect(oauthChecks).toBe(1)
  })

  test('an explicit apiKey wins over the configured one', async () => {
    const request = await sendOne({ maxRetries: 0, apiKey: 'sk-explicit' })

    expect(request.headers.get('x-api-key')).toBe('sk-explicit')
  })

  test('stamps a client request id on every first-party request', async () => {
    const first = await sendOne()
    const second = await sendOne()

    const firstId = first.headers.get('x-client-request-id')
    expect(firstId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(second.headers.get('x-client-request-id')).not.toBe(firstId)
  })

  test('keeps a client request id the caller already set', async () => {
    const requests: CapturedRequest[] = []
    globalThis.fetch = captureFetch(requests)
    const client = (await getAnthropicClient({ maxRetries: 0 })) as unknown as {
      messages: {
        create: (
          params: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<unknown>
      }
    }

    await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      },
      { headers: { 'x-client-request-id': 'caller-id' } },
    )

    expect(requests[0]?.headers.get('x-client-request-id')).toBe('caller-id')
  })

  test('a non-first-party base URL gets no client request id and the Claudin identity', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
    resolvedOverride = {
      transport: 'anthropic',
      baseUrl: 'https://gateway.example',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne()

    expect(request.url).toBe('https://gateway.example/v1/messages')
    expect(request.headers.get('x-client-request-id')).toBeNull()
    expect(request.headers.get('x-app')).toBe('claudin')
    expect(request.headers.get('x-claudin-session-id')).toBeTruthy()
  })

  test('a claude.ai subscriber authenticates with the OAuth token and no API key', async () => {
    subscriber = true
    oauthAccessToken = 'oauth-access-token'
    process.env.ANTHROPIC_AUTH_TOKEN = 'ignored-for-subscribers'

    const request = await sendOne()

    expect(request.headers.get('authorization')).toBe('Bearer oauth-access-token')
    expect(request.headers.get('x-api-key')).toBeNull()
  })

  test('ANTHROPIC_AUTH_TOKEN becomes a bearer header for API-key users', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-bearer'
    helperKey = 'helper-key'

    const request = await sendOne()

    expect(request.headers.get('authorization')).toBe('Bearer env-bearer')
  })

  test('the apiKeyHelper output becomes a bearer header when no auth token is set', async () => {
    helperKey = 'helper-key'

    const request = await sendOne()

    expect(request.headers.get('authorization')).toBe('Bearer helper-key')
  })

  test('forwards remote, client-app, protection and profile headers', async () => {
    process.env.CLAUDE_CODE_CONTAINER_ID = 'container-1'
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'remote-1'
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'my-app/1.0'
    process.env.CLAUDIN_ADDITIONAL_PROTECTION = '1'
    resolvedOverride = {
      transport: 'anthropic',
      model: 'claude-sonnet-4-6',
      extras: { customHeaders: { 'x-corp-auth': 'corp-token' } },
    } as unknown as ResolvedProvider

    const request = await sendOne()

    expect(request.headers.get('x-claude-remote-container-id')).toBe('container-1')
    expect(request.headers.get('x-claude-remote-session-id')).toBe('remote-1')
    expect(request.headers.get('x-client-app')).toBe('my-app/1.0')
    expect(request.headers.get('x-anthropic-additional-protection')).toBe('true')
    expect(request.headers.get('x-corp-auth')).toBe('corp-token')
  })

  test('leaves the optional headers out when their env vars are unset', async () => {
    const request = await sendOne()

    expect(request.headers.get('x-claude-remote-container-id')).toBeNull()
    expect(request.headers.get('x-claude-remote-session-id')).toBeNull()
    expect(request.headers.get('x-client-app')).toBeNull()
    expect(request.headers.get('x-anthropic-additional-protection')).toBeNull()
  })

  test('sends the API version Claude Code sends, not the SDK 1.x default', async () => {
    const request = await sendOne()

    expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  test('fetchOverride receives the request instead of the global fetch', async () => {
    const requests: CapturedRequest[] = []
    globalThis.fetch = (async () => {
      throw new Error('global fetch must not be called')
    }) as unknown as FetchType
    const client = (await getAnthropicClient({
      maxRetries: 0,
      fetchOverride: captureFetch(requests),
      source: 'test',
    })) as unknown as VertexClient

    await client.messages.create({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-api-key')).toBe('sk-config-key')
  })

  test('passes maxRetries and the default ten-minute timeout to the SDK', async () => {
    const client = (await getAnthropicClient({ maxRetries: 3 })) as unknown as {
      maxRetries: number
      timeout: number
    }

    expect(client.maxRetries).toBe(3)
    expect(client.timeout).toBe(600_000)
  })

  test('a numeric API_TIMEOUT_MS sets the SDK timeout', async () => {
    process.env.API_TIMEOUT_MS = '120000'

    const client = (await getAnthropicClient({ maxRetries: 0 })) as unknown as {
      timeout: number
    }

    expect(client.timeout).toBe(120_000)
  })

  test.each(['abc', '-5', '600s', '0'])(
    'an invalid API_TIMEOUT_MS (%s) keeps the default ten-minute timeout',
    async value => {
      process.env.API_TIMEOUT_MS = value

      const client = (await getAnthropicClient({ maxRetries: 0 })) as unknown as {
        timeout: number
      }

      expect(client.timeout).toBe(600_000)
    },
  )

  test('the stderr logger is attached only under --debug-to-stderr', async () => {
    const quiet = (await getAnthropicClient({ maxRetries: 0 })) as unknown as {
      logger: unknown
    }
    debugToStdErr = true
    const loud = (await getAnthropicClient({ maxRetries: 0 })) as unknown as {
      logger: Record<'error' | 'warn' | 'info' | 'debug', (msg: string) => void>
    }
    const lines: string[] = []
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '))
    })
    try {
      loud.logger.error('e')
      loud.logger.warn('w')
      loud.logger.info('i')
      loud.logger.debug('d')
    } finally {
      errorSpy.mockRestore()
    }

    expect(quiet.logger).toBe(console)
    expect(lines).toEqual([
      '[Anthropic SDK ERROR] e',
      '[Anthropic SDK WARN] w',
      '[Anthropic SDK INFO] i',
      '[Anthropic SDK DEBUG] d',
    ])
  })
})

describe('GitHub Copilot native Anthropic mode', () => {
  test('sends Claude models to the Copilot messages endpoint with the GitHub token', async () => {
    resolvedOverride = {
      transport: 'github_copilot',
      baseUrl: 'https://copilot.example/',
      model: 'claude-sonnet-4-6',
      apiKey: 'profile-key',
      extras: { githubToken: 'gh-token' },
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toBe('https://copilot.example/v1/messages')
    expect(request.headers.get('authorization')).toBe('Bearer gh-token')
    expect(request.headers.get('x-api-key')).toBeNull()
    expect(request.headers.get('copilot-integration-id')).toBe('vscode-chat')
    expect(request.headers.get('x-initiator')).toBe('user')
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  test('falls back to the profile API key and the public Copilot host', async () => {
    resolvedOverride = {
      transport: 'github_copilot',
      model: 'claude-sonnet-4-6',
      apiKey: 'profile-key',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toBe('https://api.githubcopilot.com/v1/messages')
    expect(request.headers.get('authorization')).toBe('Bearer profile-key')
  })
})

describe('Bedrock lane', () => {
  test('a Bedrock API key skips SigV4 and becomes a bearer header', async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-key'
    resolvedOverride = {
      transport: 'bedrock',
      model: 'claude-sonnet-4-6',
      extras: { awsRegion: 'eu-west-1' },
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toStartWith('https://bedrock-runtime.eu-west-1.amazonaws.com/')
    expect(request.headers.get('authorization')).toBe('Bearer bedrock-key')
    expect(awsRefreshes).toBe(0)
  })

  test('signs with the refreshed AWS credentials in the env region', async () => {
    process.env.AWS_REGION = 'us-west-2'
    awsCredentials = {
      accessKeyId: 'AKIDTESTKEY',
      secretAccessKey: 'test-secret',
      sessionToken: 'test-session-token',
    }
    resolvedOverride = {
      transport: 'bedrock',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toStartWith('https://bedrock-runtime.us-west-2.amazonaws.com/')
    expect(request.headers.get('authorization')).toContain(
      'Credential=AKIDTESTKEY/',
    )
    expect(request.headers.get('x-amz-security-token')).toBe('test-session-token')
    expect(awsRefreshes).toBe(1)
  })

  test('CLAUDIN_SKIP_BEDROCK_AUTH sends unsigned requests without refreshing credentials', async () => {
    process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
    resolvedOverride = {
      transport: 'bedrock',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toStartWith('https://bedrock-runtime.us-east-1.amazonaws.com/')
    expect(request.headers.get('authorization')).toBeNull()
    expect(awsRefreshes).toBe(0)
  })

  test('sends the Bedrock API version in the body, not the SDK 1.x default', async () => {
    process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
    resolvedOverride = {
      transport: 'bedrock',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(JSON.parse(request.body).anthropic_version).toBe('bedrock-2023-05-31')
    expect(request.headers.get('anthropic-version')).toBeNull()
  })
})

describe('Foundry lane', () => {
  test('uses the Azure-provided API key from the environment', async () => {
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'foundry-key'
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = 'https://foundry.example/anthropic'
    resolvedOverride = {
      transport: 'foundry',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toBe('https://foundry.example/anthropic/v1/messages')
    expect(request.headers.get('x-api-key')).toBe('foundry-key')
    expect(request.headers.get('authorization')).toBeNull()
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01')
  })

  test('CLAUDIN_SKIP_FOUNDRY_AUTH builds a client without an API key', async () => {
    process.env.CLAUDIN_SKIP_FOUNDRY_AUTH = '1'
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = 'https://foundry.example/anthropic'
    resolvedOverride = {
      transport: 'foundry',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const client = (await getAnthropicClient({
      maxRetries: 0,
      model: 'claude-sonnet-4-6',
    })) as unknown as { baseURL: string; timeout: number }

    expect(client.baseURL).toBe('https://foundry.example/anthropic')
    expect(client.timeout).toBe(600_000)
  })
})

describe('Vertex lane', () => {
  test('uses the profile region when no GCP region env is set', async () => {
    process.env.CLAUDIN_SKIP_VERTEX_AUTH = '1'
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project'
    resolvedOverride = {
      transport: 'vertex',
      model: 'claude-sonnet-4-6',
      extras: { gcpRegion: 'europe-west4' },
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toContain('/locations/europe-west4/')
    expect(gcpRefreshes).toBe(0)
  })

  test('CLOUD_ML_REGION wins over the profile region', async () => {
    process.env.CLAUDIN_SKIP_VERTEX_AUTH = '1'
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project'
    process.env.CLOUD_ML_REGION = 'asia-east1'
    resolvedOverride = {
      transport: 'vertex',
      model: 'claude-sonnet-4-6',
      extras: { gcpRegion: 'europe-west4' },
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(request.url).toContain('/locations/asia-east1/')
  })

  test('sends the Vertex API version in the body, not the SDK 1.x default', async () => {
    process.env.CLAUDIN_SKIP_VERTEX_AUTH = '1'
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project'
    resolvedOverride = {
      transport: 'vertex',
      model: 'claude-sonnet-4-6',
    } as unknown as ResolvedProvider

    const request = await sendOne({ maxRetries: 0, model: 'claude-sonnet-4-6' })

    expect(JSON.parse(request.body).anthropic_version).toBe('vertex-2023-10-16')
  })
})
