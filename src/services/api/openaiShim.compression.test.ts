/**
 * Stable-stub compression integrated through the OpenAI shim path.
 *
 * The legacy tiered `compressToolHistory` was deleted; this suite verifies
 * that `applyStableStubs`, called inside `_doOpenAIRequest`, rewrites
 * tool_result content for any id present in the per-session clipped set,
 * AND is a no-op when the set is empty.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}
import { createOpenAIShimClient } from './openaiShim.js'
import {
  addClippedIds,
  resetClippedIds,
} from 'src/services/compact/stableStubState.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

// Spread into a plain object so afterAll restores the original bindings,
// not the live ESM namespace which mock.module mutates after the fact.
const realConfig = { ...(await import('src/utils/config.js')) }
mock.module('src/utils/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    autoCompactEnabled: false,
  }),
}))

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>
    }
  }
}

function bigText(n: number): string {
  return 'A'.repeat(n)
}

function buildToolExchange(id: number, resultLength: number) {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `toolu_${id}`,
          name: 'Read',
          input: { file_path: `/path/to/file${id}.ts` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `toolu_${id}`,
          content: bigText(resultLength),
        },
      ],
    },
  ]
}

function buildLongConversation(numExchanges: number, resultLength = 5_000) {
  const out: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'start the work' },
  ]
  for (let i = 0; i < numExchanges; i++) {
    out.push(...buildToolExchange(i, resultLength))
  }
  return out
}

function makeFakeResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [
        {
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_MODEL
  resetClippedIds()
})

afterEach(() => {
  if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
  if (originalEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
  if (originalEnv.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL
  else process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
  globalThis.fetch = originalFetch
  resetClippedIds()
})

async function captureRequestBody(
  messages: Array<{ role: string; content: unknown }>,
  model: string,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    captured = JSON.parse(String(init?.body))
    return makeFakeResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    system: 'system prompt',
    messages,
  })

  if (!captured) throw new Error('request not captured')
  return captured
}

function getToolMessages(body: Record<string, unknown>): Array<{ content: string }> {
  const messages = body.messages as Array<{ role: string; content: string }>
  return messages.filter(m => m.role === 'tool')
}

test('empty clipped set: tool_results pass through untouched', async () => {
  const messages = buildLongConversation(5, 5_000)
  const body = await captureRequestBody(messages, 'gpt-4o')
  const toolMessages = getToolMessages(body)

  expect(toolMessages.length).toBe(5)
  for (const m of toolMessages) {
    expect(m.content.length).toBe(5_000)
    expect(m.content).not.toContain('clipped:')
  }
})

test('clipped ids are rewritten to deterministic stub strings', async () => {
  const messages = buildLongConversation(5, 5_000)
  // Clip the first three exchanges' ids — leave the last two untouched.
  addClippedIds(['toolu_0', 'toolu_1', 'toolu_2'])

  const body = await captureRequestBody(messages, 'gpt-4o')
  const toolMessages = getToolMessages(body)

  expect(toolMessages.length).toBe(5)
  for (let i = 0; i <= 2; i++) {
    expect(toolMessages[i].content).toMatch(
      /\[clipped: ~\d+ tokens from Read( — head preserved)?\]$/,
    )
  }
  for (let i = 3; i <= 4; i++) {
    expect(toolMessages[i].content.length).toBe(5_000)
    expect(toolMessages[i].content).not.toContain('clipped:')
  }
})

test('stub bytes are stable across two consecutive shim calls', async () => {
  const messages = buildLongConversation(3, 4_321)
  addClippedIds(['toolu_0'])

  const first = await captureRequestBody(messages, 'gpt-4o')
  const second = await captureRequestBody(messages, 'gpt-4o')

  const firstStub = getToolMessages(first)[0].content
  const secondStub = getToolMessages(second)[0].content
  expect(firstStub).toBe(secondStub)
})

afterAll(() => {
  mock.module('src/utils/config.js', () => realConfig)
})
