/**
 * PR5 — Wire-level benchmark for the stable-stub compression.
 *
 * Sibling tests already prove that `applyStableStubs` rewrites blocks
 * deterministically. What this file adds is the question that actually
 * matters for users: "how many bytes does the wire request shrink by, per
 * provider engine, on a realistic 30-turn session?".
 *
 * We exercise three engines:
 *   1. OpenAI Chat Completions (openaiShim)        — DeepSeek/Groq/etc.
 *   2. OpenAI Responses API (codexShim builder)    — Codex/ChatGPT OAuth
 *   3. Anthropic native (claude.ts addCacheBreakpoints + JSON)
 *
 * For each engine we capture the wire body twice: once with no clipped ids
 * (baseline), once with N-2 ids clipped (compressed). We assert the
 * compressed body is significantly smaller, and we log the numbers so
 * `bun test` stdout makes the savings visible to humans reviewing the PR.
 *
 * For Anthropic native we additionally:
 *   - assert byte-for-byte stability across two consecutive serializations
 *   - assert exactly one `cache_control` marker in the compressed body
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}
import { stableStringify } from '../../utils/stableStringify.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

// Disable autocompact so the pipeline stays predictable. Spread into a plain
// object so afterAll restores the original bindings, not the live ESM
// namespace (which mock.module mutates in place).
const realConfig = { ...(await import('../../utils/config.js')) }
mock.module('../../utils/config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({ autoCompactEnabled: false }),
}))
const realAutoCompact = { ...(await import('../compact/autoCompact.js')) }
mock.module('../compact/autoCompact.js', () => ({
  ...realAutoCompact,
  getEffectiveContextWindowSize: () => 200_000,
}))

// Imported AFTER the mocks so the stubbed config is already in place.
const {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} = await import('../compact/stableStubState.js')
const { createOpenAIShimClient } = await import('./openaiShim.js')
const { convertAnthropicMessagesToResponsesInput } = await import('./codexShim.js')

type AnyMsg = {
  role?: string
  type?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

// Compactable tool names cycled across turns so isCompactableTool returns true
// for every assistant tool_use block we generate.
const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Glob']

interface SyntheticSession {
  /** Wrapped Claudio-style messages with the {type, message} envelope. */
  wrapped: AnyMsg[]
  /** Flat {role, content} messages — the shape OpenAI shims accept. */
  flat: AnyMsg[]
  /** All compactable tool_use_ids in encounter order. */
  toolUseIds: string[]
}

/**
 * Builds a 30-turn session of assistant tool_use → user tool_result pairs,
 * followed by a final user question. Each tool_result carries `avgToolResultKB`
 * KiB of plausible-looking text so the byte savings reflect a real session.
 */
function buildSyntheticSession(opts: {
  turns: number
  avgToolResultKB: number
}): SyntheticSession {
  const wrapped: AnyMsg[] = []
  const flat: AnyMsg[] = []
  const toolUseIds: string[] = []
  const blob = 'lorem ipsum dolor sit amet '.repeat(
    Math.ceil((opts.avgToolResultKB * 1024) / 27),
  )

  for (let i = 0; i < opts.turns; i++) {
    const toolUseId = `toolu_${i.toString().padStart(4, '0')}`
    const toolName = TOOL_NAMES[i % TOOL_NAMES.length]!
    toolUseIds.push(toolUseId)

    // Assistant turn — emits one tool_use block.
    const assistantContent = [
      { type: 'text', text: `Calling ${toolName} (turn ${i})` },
      {
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: { path: `/tmp/file_${i}.txt` },
      },
    ]
    wrapped.push({
      type: 'assistant',
      message: { role: 'assistant', content: assistantContent },
    })
    flat.push({ role: 'assistant', content: assistantContent })

    // User turn — replies with a fat tool_result for that id.
    const userContent = [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `${blob}\n---turn ${i}---`,
      },
    ]
    wrapped.push({
      type: 'user',
      message: { role: 'user', content: userContent },
    })
    flat.push({ role: 'user', content: userContent })
  }

  // Final human question so the request looks like a real "go" turn.
  const finalContent = [{ type: 'text', text: 'What did you find overall?' }]
  wrapped.push({
    type: 'user',
    message: { role: 'user', content: finalContent },
  })
  flat.push({ role: 'user', content: finalContent })

  return { wrapped, flat, toolUseIds }
}

function makeOpenAIChatResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-bench',
      model: 'gpt-4o',
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

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

/**
 * Drive the openai-chat shim end-to-end and capture the bytes the underlying
 * fetch() was about to POST. applyStableStubs runs inside _doOpenAIRequest so
 * the captured body reflects exactly what a provider would see on the wire.
 */
async function captureOpenAIChatBody(messages: AnyMsg[]): Promise<string> {
  let captured: string | undefined
  globalThis.fetch = (async (_input, init) => {
    captured = String(init?.body ?? '')
    return makeOpenAIChatResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    messages,
    max_tokens: 16,
  })

  if (captured === undefined) throw new Error('chat body not captured')
  return captured
}

/**
 * The Responses API engine (codexShim). We invoke the same body builder the
 * shim uses internally — applyStableStubs + convertAnthropicMessagesToResponsesInput
 * + stableStringify — instead of the full performCodexRequest, so the test
 * doesn't need to fake Codex OAuth credentials.
 */
function captureOpenAIResponsesBody(messages: AnyMsg[]): string {
  const compressed = applyStableStubs(messages)
  const input = convertAnthropicMessagesToResponsesInput(
    compressed as Array<{
      role?: string
      message?: { role?: string; content?: unknown }
      content?: unknown
    }>,
  )
  const body = {
    model: 'gpt-5-codex',
    instructions: 'You are Claude.',
    input,
    stream: false,
  }
  return stableStringify(body)
}

/**
 * Anthropic native: drive applyStableStubs + addCacheBreakpoints (the same
 * two functions claude.ts calls right before the SDK serializes), then JSON
 * stringify the resulting body. This is one transform short of the SDK's own
 * fetch — but addCacheBreakpoints is the only Claudio-side mutation that
 * affects wire bytes for the Anthropic engine. Driving the SDK itself would
 * add zero signal and a lot of mocking.
 */
async function captureAnthropicBody(
  messages: AnyMsg[],
): Promise<{ body: string; cacheControlCount: number }> {
  const claude = await import('./claude.js')
  const compressed = applyStableStubs(messages)
  const messageParams = claude.addCacheBreakpoints(
    // Cast: addCacheBreakpoints is typed against the internal UserMessage /
    // AssistantMessage shape, but at runtime it only reads `.type`,
    // `.message.role`, and `.message.content` — all present here.
    compressed as Parameters<typeof claude.addCacheBreakpoints>[0],
    /* enablePromptCaching */ true,
  )
  const wireBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    system: 'You are Claude.',
    messages: messageParams,
  }
  const serialized = JSON.stringify(wireBody)

  // Count cache_control occurrences across all message-level content blocks.
  let cacheControlCount = 0
  for (const m of messageParams) {
    if (Array.isArray(m.content)) {
      for (const block of m.content as Array<{ cache_control?: unknown }>) {
        if (block && typeof block === 'object' && 'cache_control' in block) {
          cacheControlCount += 1
        }
      }
    }
  }

  return { body: serialized, cacheControlCount }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
  delete process.env.OPENAI_MODEL
})

afterAll(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  globalThis.fetch = originalFetch
  mock.module('../../utils/config.js', () => realConfig)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _resetAllClippedIdsForTesting()
})

// ---------------------------------------------------------------------------
// The benchmark
// ---------------------------------------------------------------------------

describe('stable-stub wire-byte benchmark per engine', () => {
  const TURNS = 30
  const AVG_KB = 4 // ~4 KiB per tool_result → ~120 KiB raw payload

  function clipAllButLastTwo(toolUseIds: string[]): void {
    addClippedIds(toolUseIds.slice(0, Math.max(0, toolUseIds.length - 2)))
  }

  function format(label: string, baseline: number, clipped: number): string {
    const reduction = ((baseline - clipped) / baseline) * 100
    return `[${label}] baseline=${baseline} bytes, clipped=${clipped} bytes, reduction=${reduction.toFixed(1)}%`
  }

  test('openai-chat: ≥40% byte reduction with clipped set populated', async () => {
    const session = buildSyntheticSession({ turns: TURNS, avgToolResultKB: AVG_KB })

    _resetAllClippedIdsForTesting()
    const baseline = (await captureOpenAIChatBody(session.flat)).length

    _resetAllClippedIdsForTesting()
    clipAllButLastTwo(session.toolUseIds)
    const clipped = (await captureOpenAIChatBody(session.flat)).length

    // eslint-disable-next-line no-console
    console.log(format('openai-chat', baseline, clipped))
    expect(clipped).toBeLessThan(baseline * 0.6)
  })

  test('openai-responses: ≥40% byte reduction', () => {
    const session = buildSyntheticSession({ turns: TURNS, avgToolResultKB: AVG_KB })

    _resetAllClippedIdsForTesting()
    const baseline = captureOpenAIResponsesBody(session.flat).length

    _resetAllClippedIdsForTesting()
    clipAllButLastTwo(session.toolUseIds)
    const clipped = captureOpenAIResponsesBody(session.flat).length

    // eslint-disable-next-line no-console
    console.log(format('openai-responses', baseline, clipped))
    expect(clipped).toBeLessThan(baseline * 0.6)
  })

  test('anthropic-native: ≥40% byte reduction + single cache_control marker', async () => {
    const session = buildSyntheticSession({ turns: TURNS, avgToolResultKB: AVG_KB })

    _resetAllClippedIdsForTesting()
    const baselineResult = await captureAnthropicBody(session.wrapped)

    _resetAllClippedIdsForTesting()
    clipAllButLastTwo(session.toolUseIds)
    const clippedResult = await captureAnthropicBody(session.wrapped)

    // eslint-disable-next-line no-console
    console.log(
      `${format('anthropic-native', baselineResult.body.length, clippedResult.body.length)} ` +
        `cache_control_markers=${clippedResult.cacheControlCount}`,
    )

    expect(clippedResult.body.length).toBeLessThan(baselineResult.body.length * 0.6)
    // Exactly one message-level cache_control marker, regardless of clipping.
    // Anything else means a leak (multiple markers waste tokens and confuse
    // mycro's local-attention KV eviction; see addCacheBreakpoints comment).
    expect(clippedResult.cacheControlCount).toBe(1)
    expect(baselineResult.cacheControlCount).toBe(1)
  })

  test('byte-stability: two consecutive anthropic-native serializations match', async () => {
    const session = buildSyntheticSession({ turns: TURNS, avgToolResultKB: AVG_KB })

    _resetAllClippedIdsForTesting()
    clipAllButLastTwo(session.toolUseIds)

    const first = (await captureAnthropicBody(session.wrapped)).body
    const second = (await captureAnthropicBody(session.wrapped)).body

    expect(second).toBe(first)
  })
})
