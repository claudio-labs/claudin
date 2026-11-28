/**
 * The API-count paths of tokenEstimation: `countMessagesTokensWithAPI` (the
 * first-party / Vertex client lane and the Bedrock CountTokens lane),
 * `countTokensWithAPI`, and `countTokensViaHaikuFallback`.
 *
 * Provider selection goes through a real profile in the global config. The
 * client is the one seam faked: `getAnthropicClient` is spied to hand back an
 * object whose `beta.messages.countTokens` records its params — except in the
 * shim test, which uses the real factory. Bedrock goes over the wire to a
 * local server (`ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDIN_SKIP_BEDROCK_AUTH`)
 * through the real AWS SDK; only the inference-profile lookup is spied,
 * because `@aws-sdk/client-bedrock` is not installed.
 *
 * `withTokenCountVCR` records under `NODE_ENV=test`: each test gets a fresh
 * fixture root in a temp dir (and `VCR_RECORD=1`, so CI does not refuse the
 * missing fixture), which keeps a recorded result from answering a later
 * test and keeps cassettes out of the checkout.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetGlobalConfigForTests,
  saveGlobalConfig,
  type ProviderProfile,
} from 'src/platform/config/config.js'
import { _setSecureStorageForTesting } from 'src/platform/secureStorage/index.js'
import type { SecureStorage } from 'src/platform/secureStorage/index.js'
import { clearOAuthTokenCache } from 'src/providers/auth/auth.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { invalidateClientCache } from 'src/providers/transport/clientCache.js'
import {
  CLAUDE_CODE_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
} from 'src/shared/constants/betas.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  countTokensWithAPI,
} from 'src/shared/tokenEstimation.js'

const clientModule = await import('src/providers/transport/client.js')
const betasModule = await import('src/providers/transport/betas.js')
const bedrockModule = await import('src/providers/model/bedrock.js')
const logModule = await import('src/shared/log.js')
const modelModule = await import('src/providers/model/model.js')

type Params = Record<string, unknown>
type Messages = Parameters<typeof countMessagesTokensWithAPI>[0]
type Tools = Parameters<typeof countMessagesTokensWithAPI>[1]

// ── profiles ────────────────────────────────────────────────────────────────

const ANTHROPIC: ProviderProfile = {
  id: 'tokest-anthropic',
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5-20250929',
  apiKey: 'sk-ant-tokest',
}
const ANTHROPIC_ADAPTIVE: ProviderProfile = {
  ...ANTHROPIC,
  id: 'tokest-anthropic-adaptive',
  model: 'claude-opus-5-5',
}
const VERTEX: ProviderProfile = {
  id: 'tokest-vertex',
  name: 'Vertex',
  provider: 'vertex',
  baseUrl: 'https://us-east5-aiplatform.googleapis.com',
  model: 'claude-sonnet-4-5@20250929',
}
const OPENAI: ProviderProfile = {
  id: 'tokest-openai',
  name: 'Local Ollama',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  apiKey: 'ollama',
}
const BEDROCK_FOUNDATION = 'anthropic.claude-sonnet-4-5-20250929-v1:0'
const BEDROCK_PROFILE_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
function bedrockProfile(model: string): ProviderProfile {
  return {
    id: `tokest-bedrock-${model}`,
    name: 'Bedrock',
    provider: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    model,
  }
}

function useProfile(profile: ProviderProfile): void {
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [profile],
    activeProviderProfileId: profile.id,
  }))
  invalidateActiveProviderCache()
  invalidateClientCache()
  clearOAuthTokenCache()
  // The main-loop model is the profile's. Pinned, because a full run can leave
  // src/providers/model/model.js mocked by an earlier file (ten files mock it).
  spies.push(spyOn(modelModule, 'getMainLoopModel').mockImplementation(() => profile.model))
}

// ── env / global state ──────────────────────────────────────────────────────

const ENV_KEYS = [
  'CLAUDIN_TEST_FIXTURES_ROOT',
  'VCR_RECORD',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDIN_SKIP_BEDROCK_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
  'CLOUD_ML_REGION',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map(k => [k, process.env[k]]),
)

const emptyStorage: SecureStorage = {
  name: 'token-estimation-empty',
  read: () => null,
  readAsync: async () => null,
  update: () => ({ success: true }),
  delete: () => true,
}

let fixtureRoot = ''
const spies: Array<{ mockRestore: () => void }> = []
let logErrorSpy: ReturnType<typeof spyOn<typeof logModule, 'logError'>>

/** The betas every count request carries; one Vertex allows, one it does not. */
const BETAS = [CLAUDE_CODE_20250219_BETA_HEADER, CONTEXT_1M_BETA_HEADER]
let betas: string[] = BETAS

/** A client whose countTokens records each call and answers `answer`. */
function fakeCountingClient(answer: () => Promise<unknown>): Params[] {
  const calls: Params[] = []
  spies.push(
    spyOn(clientModule, 'getAnthropicClient').mockImplementation((async () => ({
      beta: {
        messages: {
          countTokens: async (params: Params) => {
            calls.push(params)
            return answer()
          },
        },
      },
    })) as unknown as typeof clientModule.getAnthropicClient),
  )
  return calls
}

beforeAll(() => {
  _setSecureStorageForTesting(emptyStorage)
})

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  fixtureRoot = mkdtempSync(join(tmpdir(), 'tokest-vcr-'))
  process.env.CLAUDIN_TEST_FIXTURES_ROOT = fixtureRoot
  process.env.VCR_RECORD = '1'
  betas = BETAS
  spies.push(
    spyOn(betasModule, 'getModelBetas').mockImplementation(
      (() => betas) as unknown as typeof betasModule.getModelBetas,
    ),
  )
  logErrorSpy = spyOn(logModule, 'logError')
  spies.push(logErrorSpy)
  useProfile(ANTHROPIC)
})

afterEach(() => {
  while (spies.length > 0) spies.pop()!.mockRestore()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fixtureRoot, { recursive: true, force: true })
  resetGlobalConfigForTests()
  invalidateActiveProviderCache()
  invalidateClientCache()
  clearOAuthTokenCache()
})

afterAll(() => {
  _setSecureStorageForTesting(null)
})

// ── the client lane ─────────────────────────────────────────────────────────

describe('countMessagesTokensWithAPI — client lane', () => {
  test('sends the normalized main-loop model, the messages, the tools and the betas', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 321 }))
    const messages: Messages = [{ role: 'user', content: 'hello there' }]
    const tools = [
      { name: 'Read', description: 'reads', input_schema: { type: 'object' as const } },
    ] as Tools

    const result = await countMessagesTokensWithAPI(messages, tools)

    expect(result).toBe(321)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe(ANTHROPIC.model)
    expect(calls[0]!.messages).toEqual(messages)
    expect(calls[0]!.tools).toEqual(tools)
    expect(calls[0]!.betas).toEqual(BETAS)
    expect(calls[0]!).not.toHaveProperty('thinking')
  })

  test('strips the [1m] suffix from the model it sends', async () => {
    useProfile({ ...ANTHROPIC, id: 'tokest-1m', model: 'claude-sonnet-4-5-20250929[1m]' })
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countMessagesTokensWithAPI([{ role: 'user', content: 'x' }], [])

    expect(calls[0]!.model).toBe('claude-sonnet-4-5-20250929')
  })

  test('an empty history gets a dummy user message so the tools still count', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 77 }))
    const tools = [
      { name: 'Grep', description: 'greps', input_schema: { type: 'object' as const } },
    ] as Tools

    expect(await countMessagesTokensWithAPI([], tools)).toBe(77)
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'foo' }])
    expect(calls[0]!.tools).toEqual(tools)
  })

  test('no betas → no betas key on the request', async () => {
    betas = []
    const calls = fakeCountingClient(async () => ({ input_tokens: 5 }))

    await countMessagesTokensWithAPI([{ role: 'user', content: 'nobeta' }], [])

    expect(calls[0]!).not.toHaveProperty('betas')
  })

  test('Vertex keeps only the betas its count_tokens endpoint accepts', async () => {
    useProfile(VERTEX)
    const calls = fakeCountingClient(async () => ({ input_tokens: 9 }))

    await countMessagesTokensWithAPI([{ role: 'user', content: 'vertex' }], [])

    expect(calls[0]!.betas).toEqual([CLAUDE_CODE_20250219_BETA_HEADER])
  })

  test('Vertex drops the betas key altogether when none survive the filter', async () => {
    useProfile(VERTEX)
    betas = [CONTEXT_1M_BETA_HEADER]
    const calls = fakeCountingClient(async () => ({ input_tokens: 9 }))

    await countMessagesTokensWithAPI([{ role: 'user', content: 'vertex-none' }], [])

    expect(calls[0]!).not.toHaveProperty('betas')
  })

  test.each([
    ['a budget model', ANTHROPIC, { type: 'enabled', budget_tokens: 1024 }],
    ['an adaptive-only model', ANTHROPIC_ADAPTIVE, { type: 'adaptive' }],
  ] as const)('a history with thinking blocks enables thinking on %s', async (_label, profile, thinking) => {
    useProfile(profile)
    const calls = fakeCountingClient(async () => ({ input_tokens: 3 }))

    await countMessagesTokensWithAPI(
      [
        { role: 'user', content: `think ${profile.id}` },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] },
      ],
      [],
    )

    expect(calls[0]!.thinking).toEqual(thinking)
  })

  test('a response without a numeric input_tokens is null, not an error', async () => {
    const calls = fakeCountingClient(async () => ({
      Output: { __type: 'com.amazon.coral.service#UnknownOperationException' },
      Version: '1.0',
    }))

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'odd' }], [])).toBeNull()
    expect(calls).toHaveLength(1)
    expect(logErrorSpy).not.toHaveBeenCalled()
  })

  test('a throwing countTokens is logged and becomes null', async () => {
    const boom = new Error('count_tokens exploded')
    fakeCountingClient(async () => {
      throw boom
    })

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'boom' }], [])).toBeNull()
    expect(logErrorSpy).toHaveBeenCalledTimes(1)
    expect(logErrorSpy.mock.calls[0]![0]).toBe(boom)
  })

  test('the OpenAI shim client has no countTokens: null without an error log', async () => {
    useProfile(OPENAI)
    // The real factory needs the build-time MACRO for its User-Agent.
    const globals = globalThis as Record<string, unknown>
    const savedMacro = globals.MACRO
    globals.MACRO = { VERSION: 'test-version' }
    try {
      // The real factory: an openai_compat profile gets the shim client.
      const client = await clientModule.getAnthropicClient({ maxRetries: 0 })
      expect(typeof (client.beta.messages as { countTokens?: unknown }).countTokens).not.toBe(
        'function',
      )

      expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'shim' }], [])).toBeNull()
      expect(logErrorSpy).not.toHaveBeenCalled()
    } finally {
      if (savedMacro === undefined) delete globals.MACRO
      else globals.MACRO = savedMacro
    }
  })
})

describe('countTokensWithAPI', () => {
  test('empty content is 0 without touching a client', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 99 }))

    expect(await countTokensWithAPI('')).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test('wraps the string as one user message with no tools', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 12 }))

    expect(await countTokensWithAPI('count me')).toBe(12)
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'count me' }])
    expect(calls[0]!.tools).toEqual([])
  })
})

// ── the Bedrock lane ────────────────────────────────────────────────────────

type BedrockRequest = { path: string; body: Params }

describe('countMessagesTokensWithAPI — Bedrock CountTokens', () => {
  let server: ReturnType<typeof Bun.serve>
  let requests: BedrockRequest[] = []
  let reply: () => Response = () => Response.json({ inputTokens: 0 })

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        requests.push({
          path: decodeURIComponent(new URL(req.url).pathname),
          body: (await req.json()) as Params,
        })
        return reply()
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  beforeEach(() => {
    requests = []
    reply = () => Response.json({ inputTokens: 0 })
    process.env.ANTHROPIC_BEDROCK_BASE_URL = `http://127.0.0.1:${server.port}`
    process.env.CLAUDIN_SKIP_BEDROCK_AUTH = '1'
  })

  /** The Anthropic body Bedrock receives, base64 inside `invokeModel`. */
  function invokeBody(request: BedrockRequest): Params {
    const input = request.body.input as { invokeModel: { body: string } }
    return JSON.parse(Buffer.from(input.invokeModel.body, 'base64').toString('utf8')) as Params
  }

  test('a foundation model is counted under its own id', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    reply = () => Response.json({ inputTokens: 4242 })
    const messages: Messages = [{ role: 'user', content: 'bedrock hello' }]
    const tools = [
      { name: 'Read', description: 'reads', input_schema: { type: 'object' as const } },
    ] as Tools

    expect(await countMessagesTokensWithAPI(messages, tools)).toBe(4242)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe(`/model/${BEDROCK_FOUNDATION}/count-tokens`)
    const body = invokeBody(requests[0]!)
    expect(body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(body.messages).toEqual(messages)
    expect(body.max_tokens).toBe(1)
    expect(body.tools).toEqual(tools)
    expect(body.anthropic_beta).toEqual(BETAS)
    expect(body).not.toHaveProperty('thinking')
  })

  test('a Converse model is not counted: CountTokens takes the Anthropic body', async () => {
    // Not an anthropic.* id, so without the guard it is looked up as an
    // inference profile, through a control plane that is not installed.
    const lookup = spyOn(bedrockModule, 'getInferenceProfileBackingModel')
    spies.push(lookup)
    useProfile(bedrockProfile('amazon.nova-micro-v1:0'))
    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'nova hello' }], [])).toBeNull()
    expect(requests).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    expect(logErrorSpy).not.toHaveBeenCalled()
  })

  test('an empty history gets the dummy message; no tools and no betas → neither key', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    betas = []
    reply = () => Response.json({ inputTokens: 8 })

    expect(await countMessagesTokensWithAPI([], [])).toBe(8)

    const body = invokeBody(requests[0]!)
    expect(body.messages).toEqual([{ role: 'user', content: 'foo' }])
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('anthropic_beta')
  })

  test('a history with thinking raises max_tokens above the thinking budget', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    reply = () => Response.json({ inputTokens: 30 })

    await countMessagesTokensWithAPI(
      [
        { role: 'user', content: 'bedrock think' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }] },
      ],
      [],
    )

    const body = invokeBody(requests[0]!)
    expect(body.max_tokens).toBe(2048)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  test('an inference profile is counted under its backing foundation model', async () => {
    useProfile(bedrockProfile(BEDROCK_PROFILE_ID))
    const lookup = spyOn(bedrockModule, 'getInferenceProfileBackingModel').mockImplementation(
      (async () => BEDROCK_FOUNDATION) as unknown as typeof bedrockModule.getInferenceProfileBackingModel,
    )
    spies.push(lookup)
    reply = () => Response.json({ inputTokens: 55 })

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'via profile' }], [])).toBe(55)

    expect(lookup).toHaveBeenCalledWith(BEDROCK_PROFILE_ID)
    expect(requests[0]!.path).toBe(`/model/${BEDROCK_FOUNDATION}/count-tokens`)
  })

  test('an inference profile with no resolvable backing model is null and sends nothing', async () => {
    useProfile(bedrockProfile(BEDROCK_PROFILE_ID))
    spies.push(
      spyOn(bedrockModule, 'getInferenceProfileBackingModel').mockImplementation(
        (async () => null) as unknown as typeof bedrockModule.getInferenceProfileBackingModel,
      ),
    )

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'no backing' }], [])).toBeNull()
    expect(requests).toHaveLength(0)
    expect(logErrorSpy).not.toHaveBeenCalled()
  })

  test('a response without inputTokens is null', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    reply = () => Response.json({})

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'empty reply' }], [])).toBeNull()
    expect(requests).toHaveLength(1)
  })

  test('a rejected request is logged and becomes null', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    reply = () =>
      Response.json(
        { message: 'The provided model identifier is invalid.' },
        { status: 400, headers: { 'x-amzn-ErrorType': 'ValidationException' } },
      )

    expect(await countMessagesTokensWithAPI([{ role: 'user', content: 'rejected' }], [])).toBeNull()
    expect(logErrorSpy).toHaveBeenCalledTimes(1)
    expect(String(logErrorSpy.mock.calls[0]![0])).toContain('model identifier is invalid')
  })
})

// ── the haiku fallback ──────────────────────────────────────────────────────

describe('countTokensViaHaikuFallback', () => {
  test('strips tool-search fields: caller on tool_use, tool_reference in tool_result', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 10 }))
    const messages = [
      { role: 'user', content: 'plain string content' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'ToolSearch',
            input: { query: 'x' },
            caller: { type: 'direct' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'tool_reference', tool_name: 'Grep' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: [
              { type: 'text', text: 'kept' },
              { type: 'tool_reference', tool_name: 'Glob' },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_3',
            content: [{ type: 'text', text: 'untouched' }],
          },
          { type: 'tool_result', tool_use_id: 'tu_4', content: 'a string result' },
        ],
      },
    ] as unknown as Messages

    expect(await countTokensViaHaikuFallback(messages, [])).toBe(10)

    const sent = calls[0]!.messages as Array<{ content: unknown }>
    expect(sent[0]!.content).toBe('plain string content')
    expect(sent[1]!.content).toEqual([
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'tu_1', name: 'ToolSearch', input: { query: 'x' } },
    ])
    expect(sent[2]!.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [{ type: 'text', text: '[tool references]' }],
      },
      { type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: 'kept' }] },
      { type: 'tool_result', tool_use_id: 'tu_3', content: [{ type: 'text', text: 'untouched' }] },
      { type: 'tool_result', tool_use_id: 'tu_4', content: 'a string result' },
    ])
    // The caller's own messages are not mutated.
    expect((messages[1]!.content as unknown[])[1]).toHaveProperty('caller')
  })

  test('an empty history counts a placeholder; empty tools are omitted, present tools sent', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 2 }))
    const tools = [
      { name: 'Read', description: 'reads', input_schema: { type: 'object' as const } },
    ] as Tools

    await countTokensViaHaikuFallback([], [])
    await countTokensViaHaikuFallback([], tools)

    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'count' }])
    expect(calls[0]!.tools).toBeUndefined()
    expect(calls[1]!.tools).toEqual(tools)
  })

  test('counts on the small fast model by default', async () => {
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countTokensViaHaikuFallback([{ role: 'user', content: 'which model' }], [])

    expect(calls[0]!.model).toBe(modelModule.getSmallFastModel())
  })

  test('Vertex filters betas the same way the primary path does', async () => {
    useProfile(VERTEX)
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countTokensViaHaikuFallback([{ role: 'user', content: 'vertex betas' }], [])

    expect(calls[0]!.betas).toEqual([CLAUDE_CODE_20250219_BETA_HEADER])
  })

  test('Vertex in the global region counts on Sonnet (no Haiku there)', async () => {
    useProfile(VERTEX)
    process.env.CLOUD_ML_REGION = 'global'
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countTokensViaHaikuFallback([{ role: 'user', content: 'global' }], [])

    const sonnet = modelModule.getDefaultSonnetModel()
    expect(sonnet).not.toBe(modelModule.getSmallFastModel())
    expect(calls[0]!.model).toBe(sonnet)
  })

  test.each([
    ['Bedrock', bedrockProfile(BEDROCK_FOUNDATION)],
    ['Vertex', VERTEX],
  ] as const)('%s with thinking blocks counts on Sonnet', async (_label, profile) => {
    useProfile(profile)
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countTokensViaHaikuFallback(
      [
        { role: 'user', content: 'cloud thinking' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 's' }] },
      ],
      [],
    )

    const sonnet = modelModule.getDefaultSonnetModel()
    expect(sonnet).not.toBe(modelModule.getSmallFastModel())
    expect(calls[0]!.model).toBe(sonnet)
  })

  test('Bedrock without thinking blocks stays on the small fast model', async () => {
    useProfile(bedrockProfile(BEDROCK_FOUNDATION))
    const calls = fakeCountingClient(async () => ({ input_tokens: 1 }))

    await countTokensViaHaikuFallback([{ role: 'user', content: 'cloud plain' }], [])

    expect(calls[0]!.model).toBe(modelModule.getSmallFastModel())
  })

  test('a response without a numeric input_tokens is null', async () => {
    fakeCountingClient(async () => ({}))

    expect(await countTokensViaHaikuFallback([{ role: 'user', content: 'x' }], [])).toBeNull()
  })
})
