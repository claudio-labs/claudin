import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as clientCache from 'src/providers/transport/clientCache.js'
import { getAnthropicClient } from 'src/providers/transport/client.js'
import { executeNonStreamingRequest } from 'src/providers/shims/claude/nonStreamingRequest.js'
import { MAX_NON_STREAMING_TOKENS } from 'src/providers/shims/claude/paramBuilders.js'
import type { SystemAPIErrorMessage } from 'src/shared/types/message.js'

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DIAGNOSTICS_FILE',
  'CLAUDIN_MAX_RETRIES',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_REMOTE',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

const tempDir = mkdtempSync(join(tmpdir(), 'non-streaming-request-'))
const diagFile = join(tempDir, 'diag.jsonl')

type CreateCall = {
  params: Record<string, unknown>
  options: { signal?: AbortSignal; timeout?: number }
}
type ClientRequest = Parameters<typeof clientCache.getCachedAnthropicClient>[1]

let createCalls: CreateCall[] = []
let clientRequests: Array<{ factory: unknown; params: ClientRequest }> = []
let outcomes: Array<() => unknown> = []

const MESSAGE: BetaMessage = {
  id: 'msg_fallback',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'fallback ok', citations: null }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 5,
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
  },
} as unknown as BetaMessage

const fakeClient = {
  beta: {
    messages: {
      create: async (
        params: Record<string, unknown>,
        options: CreateCall['options'],
      ) => {
        createCalls.push({ params, options })
        const next = outcomes.shift()
        return next ? next() : MESSAGE
      },
    },
  },
} as unknown as Anthropic

const spies: Array<{ mockRestore: () => void }> = []

beforeAll(() => {
  process.env.CLAUDIN_CONFIG_DIR = tempDir
  spies.push(
    spyOn(clientCache, 'getCachedAnthropicClient').mockImplementation(
      async (factory, params) => {
        clientRequests.push({ factory, params })
        return fakeClient
      },
    ),
  )
})

afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  createCalls = []
  clientRequests = []
  outcomes = []
  delete process.env.CLAUDIN_MAX_RETRIES
  delete process.env.API_TIMEOUT_MS
  delete process.env.CLAUDE_CODE_REMOTE
  process.env.CLAUDIN_DIAGNOSTICS_FILE = diagFile
  rmSync(diagFile, { force: true })
})

function params(overrides: Partial<BetaMessageStreamParams> = {}): BetaMessageStreamParams {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  } as BetaMessageStreamParams
}

type RunOptions = {
  signal?: AbortSignal
  paramsFromContext?: () => BetaMessageStreamParams
}

type RunResult = {
  message: BetaMessage
  yielded: SystemAPIErrorMessage[]
  attempts: Array<{ attempt: number; start: number; maxOutputTokens: number }>
  captured: BetaMessageStreamParams[]
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const attempts: RunResult['attempts'] = []
  const captured: BetaMessageStreamParams[] = []
  const yielded: SystemAPIErrorMessage[] = []
  const fetchOverride = (async () => new Response()) as unknown as typeof fetch
  const generator = executeNonStreamingRequest(
    { model: 'claude-sonnet-4-6', fetchOverride, source: 'test-source' },
    {
      model: 'claude-sonnet-4-6',
      thinkingConfig: { type: 'disabled' },
      signal: options.signal ?? new AbortController().signal,
      querySource: 'repl_main_thread',
    },
    options.paramsFromContext ?? (() => params()),
    (attempt, start, maxOutputTokens) => {
      attempts.push({ attempt, start, maxOutputTokens })
    },
    p => {
      captured.push(p)
    },
  )
  let step = await generator.next()
  while (!step.done) {
    yielded.push(step.value)
    step = await generator.next()
  }
  return { message: step.value, yielded, attempts, captured }
}

function diagEvents(): string[] {
  if (!existsSync(diagFile)) return []
  return readFileSync(diagFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { event: string }).event)
}

describe('executeNonStreamingRequest', () => {
  test('returns the message from a single successful attempt', async () => {
    const { message, yielded, attempts, captured } = await run()

    expect(message).toBe(MESSAGE)
    expect(yielded).toEqual([])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.attempt).toBe(1)
    expect(attempts[0]?.maxOutputTokens).toBe(1024)
    expect(captured).toEqual([params()])
    expect(createCalls).toHaveLength(1)
  })

  test('builds the client without SDK retries for the requested model and source', async () => {
    await run()

    expect(clientRequests).toHaveLength(1)
    expect(clientRequests[0]?.factory).toBe(getAnthropicClient)
    expect(clientRequests[0]?.params).toMatchObject({
      maxRetries: 0,
      model: 'claude-sonnet-4-6',
      source: 'test-source',
    })
    expect(typeof clientRequests[0]?.params.fetchOverride).toBe('function')
  })

  test('caps max_tokens and the thinking budget for the non-streaming request', async () => {
    const { attempts } = await run({
      paramsFromContext: () =>
        params({
          max_tokens: 200_000,
          thinking: { type: 'enabled', budget_tokens: 150_000 },
        }),
    })

    expect(attempts[0]?.maxOutputTokens).toBe(200_000)
    expect(createCalls[0]?.params.max_tokens).toBe(MAX_NON_STREAMING_TOKENS)
    expect(createCalls[0]?.params.thinking).toEqual({
      type: 'enabled',
      budget_tokens: MAX_NON_STREAMING_TOKENS - 1,
    })
  })

  test('strips the context-window suffix from the model sent to the API', async () => {
    await run({
      paramsFromContext: () => params({ model: 'claude-sonnet-4-6[1m]' }),
    })

    expect(createCalls[0]?.params.model).toBe('claude-sonnet-4-6')
  })

  test('passes the caller signal to the request', async () => {
    const controller = new AbortController()

    await run({ signal: controller.signal })

    expect(createCalls[0]?.options.signal).toBe(controller.signal)
  })

  test('yields the retry notice for a retryable API error and returns the next attempt', async () => {
    outcomes = [
      () => {
        throw APIError.generate(
          500,
          { type: 'error', error: { type: 'api_error', message: 'boom' } },
          'boom',
          new Headers({ 'retry-after-ms': '1' }),
        )
      },
    ]

    const { message, yielded, attempts } = await run()

    expect(message).toBe(MESSAGE)
    expect(yielded).toHaveLength(1)
    expect(yielded[0]?.type).toBe('system')
    expect(attempts.map(a => a.attempt)).toEqual([1, 2])
    expect(createCalls).toHaveLength(2)
    expect(diagEvents()).toEqual(['cli_nonstreaming_fallback_error'])
  })

  test('a non-API error is logged to diagnostics and stops the request', async () => {
    outcomes = [
      () => {
        throw new Error('socket hang up')
      },
    ]

    await expect(run()).rejects.toThrow('socket hang up')
    expect(createCalls).toHaveLength(1)
    expect(diagEvents()).toEqual(['cli_nonstreaming_fallback_error'])
  })

  test('a user abort is rethrown without a diagnostics entry', async () => {
    outcomes = [
      () => {
        throw new APIUserAbortError()
      },
    ]

    await expect(run()).rejects.toThrow()
    expect(diagEvents()).toEqual([])
  })

  test('an already-aborted signal sends nothing', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(run({ signal: controller.signal })).rejects.toBeInstanceOf(
      APIUserAbortError,
    )
    expect(createCalls).toHaveLength(0)
  })
})

describe('fallback timeout', () => {
  test('defaults to 300 seconds', async () => {
    await run()

    expect(createCalls[0]?.options.timeout).toBe(300_000)
  })

  test('remote sessions default to 120 seconds', async () => {
    process.env.CLAUDE_CODE_REMOTE = '1'

    await run()

    expect(createCalls[0]?.options.timeout).toBe(120_000)
  })

  test('a numeric API_TIMEOUT_MS wins over both defaults', async () => {
    process.env.API_TIMEOUT_MS = '45000'
    process.env.CLAUDE_CODE_REMOTE = '1'

    await run()

    expect(createCalls[0]?.options.timeout).toBe(45_000)
  })

  test.each(['abc', '-5', '600s'])('an invalid API_TIMEOUT_MS (%s) keeps the default', async value => {
    process.env.API_TIMEOUT_MS = value

    await run()

    expect(createCalls[0]?.options.timeout).toBe(300_000)
  })
})
