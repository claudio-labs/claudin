/**
 * Identity-cache tests for the per-block conversion memoization
 * (messageConverter.ts) and per-tool conversion memoization (toolConverter.ts).
 *
 * The upstream render pipeline rebuilds every top-level message wrapper on
 * every request but keeps deep content-block objects by reference for
 * unchanged history. These tests simulate exactly that shape: fresh wrappers
 * and fresh content arrays per "turn", shared block/input/schema objects —
 * and prove:
 *  (a) repeated conversion is output-equivalent to a fresh conversion,
 *  (b) the caches are actually hit (compute counters + reference equality),
 *  (c) a replaced block/schema object is re-converted (no stale data).
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  _conversionCacheStatsForTesting,
  convertMessages,
} from '../messageConverter.js'
import {
  _toolConversionCacheStatsForTesting,
  convertTools,
} from '../toolConverter.js'

// ---------------------------------------------------------------------------
// Shared "session" objects — stable identities across simulated turns, the
// way QueryEngine history blocks survive normalizeMessagesForAPI /
// addCacheBreakpoints (wrappers cloned, blocks kept by ref).
// ---------------------------------------------------------------------------

const stableToolUseInput = {
  file_path: '/tmp/big.ts',
  content: 'x'.repeat(5_000),
}

// Mixed text+image content so the converted form is an ARRAY — observable
// via reference equality across conversions.
const stableToolResultBlock = {
  type: 'tool_result',
  tool_use_id: 'call_1',
  content: [
    { type: 'text', text: 'wrote 5000 bytes' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
    },
  ],
}

const stableTextBlock = { type: 'text', text: 'please write the file' }

/**
 * Build one "turn" of history: fresh message wrappers, fresh content arrays,
 * fresh tool_use block (normalizeMessagesForAPI rebuilds assistant tool_use
 * blocks every request) — but stable deep refs for the text block, the
 * tool_use `input`, and the tool_result block.
 */
function buildHistory(): Array<{ role: string; content: unknown }> {
  return [
    { role: 'user', content: [stableTextBlock] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'Write',
          input: stableToolUseInput,
        },
      ],
    },
    { role: 'user', content: [stableToolResultBlock] },
  ]
}

type ConvertMessagesInput = Parameters<typeof convertMessages>[0]

function convert(history: Array<{ role: string; content: unknown }>) {
  return convertMessages(history as ConvertMessagesInput, 'sys prompt')
}

describe('messageConverter identity caches', () => {
  test('repeated conversion of the same history equals a fresh conversion', () => {
    const out1 = convert(buildHistory())
    const out2 = convert(buildHistory())
    expect(out2).toEqual(out1)

    // Fresh conversion: deep-cloned history shares no identities, so every
    // block is converted from scratch — output must still be equivalent.
    const fresh = convert(structuredClone(buildHistory()))
    expect(fresh).toEqual(out1)
  })

  test('tool_result conversion is cached: no recompute, same content reference', () => {
    const out1 = convert(buildHistory())
    const before = _conversionCacheStatsForTesting.toolResultComputes
    const out2 = convert(buildHistory())
    expect(_conversionCacheStatsForTesting.toolResultComputes).toBe(before)

    const tool1 = out1.find(m => m.role === 'tool')
    const tool2 = out2.find(m => m.role === 'tool')
    expect(tool1).toBeDefined()
    expect(Array.isArray(tool1?.content)).toBe(true)
    // Cache hit ⇒ the exact same converted array object is reused.
    expect(tool2?.content).toBe(tool1!.content)
  })

  test('tool_use arguments stringification is cached on the input object', () => {
    convert(buildHistory())
    const before = _conversionCacheStatsForTesting.toolUseArgumentsComputes
    const out = convert(buildHistory())
    expect(_conversionCacheStatsForTesting.toolUseArgumentsComputes).toBe(before)

    const assistant = out.find(m => m.role === 'assistant' && m.tool_calls?.length)
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe(
      JSON.stringify(stableToolUseInput),
    )
  })

  test('a replaced tool_result block is re-converted (no stale data)', () => {
    convert(buildHistory())
    const before = _conversionCacheStatsForTesting.toolResultComputes

    // Simulate applyStableStubs: the rewriter replaces the block with a NEW
    // object carrying stub content (it never mutates in place).
    const stubbedBlock = {
      ...stableToolResultBlock,
      content: '[clipped: ~1234 tokens from Write]',
    }
    const history = buildHistory()
    history[2] = { role: 'user', content: [stubbedBlock] }

    const out = convert(history)
    expect(_conversionCacheStatsForTesting.toolResultComputes).toBe(before + 1)
    const tool = out.find(m => m.role === 'tool')
    expect(tool?.content).toBe('[clipped: ~1234 tokens from Write]')
  })

  test('a replaced tool_use input is re-stringified (no stale arguments)', () => {
    convert(buildHistory())
    const before = _conversionCacheStatsForTesting.toolUseArgumentsComputes

    const newInput = { file_path: '/tmp/big.ts', content: 'replaced' }
    const history = buildHistory()
    history[1] = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'Write', input: newInput }],
    }

    const out = convert(history)
    expect(_conversionCacheStatsForTesting.toolUseArgumentsComputes).toBe(before + 1)
    const assistant = out.find(m => m.role === 'assistant' && m.tool_calls?.length)
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe(
      JSON.stringify(newInput),
    )
  })

  test('error-prefixed string tool_result round-trips through the cache unchanged', () => {
    const errBlock = {
      type: 'tool_result',
      tool_use_id: 'call_err',
      content: 'boom',
      is_error: true,
    }
    const history = () => [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_err', name: 'Bash', input: {} }],
      },
      { role: 'user', content: [errBlock] },
    ]
    const out1 = convert(history())
    const out2 = convert(history())
    const tool1 = out1.find(m => m.role === 'tool')
    const tool2 = out2.find(m => m.role === 'tool')
    expect(tool1?.content).toBe('Error: boom')
    expect(tool2?.content).toBe('Error: boom')
  })
})

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

const stableSchema = {
  type: 'object',
  properties: {
    a: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['a'],
}

function buildTools() {
  // Fresh wrapper objects per call (matches toolToAPISchema output shape),
  // stable input_schema reference (session-stable schema cache upstream).
  return [
    { name: 'Calc', description: 'adds numbers', input_schema: stableSchema },
  ]
}

describe('convertTools identity cache', () => {
  afterEach(() => {
    delete process.env.CLAUDIN_DISABLE_STRICT_TOOLS
  })

  test('repeated conversion returns equivalent output and reuses the cached tool', () => {
    const out1 = convertTools(buildTools())
    const before = _toolConversionCacheStatsForTesting.computes
    const out2 = convertTools(buildTools())

    expect(out2).toEqual(out1)
    expect(_toolConversionCacheStatsForTesting.computes).toBe(before)
    // Cache hit ⇒ the exact same OpenAITool object is reused.
    expect(out2[0]).toBe(out1[0])
  })

  test('a fresh (cloned) schema object is re-converted to equivalent output', () => {
    const out1 = convertTools(buildTools())
    const before = _toolConversionCacheStatsForTesting.computes
    const out2 = convertTools([
      { name: 'Calc', description: 'adds numbers', input_schema: structuredClone(stableSchema) },
    ])
    expect(_toolConversionCacheStatsForTesting.computes).toBe(before + 1)
    expect(out2).toEqual(out1)
    expect(out2[0]).not.toBe(out1[0])
  })

  test('changed name or description on the same schema recomputes (no stale entry)', () => {
    convertTools(buildTools())
    const before = _toolConversionCacheStatsForTesting.computes
    const out = convertTools([
      { name: 'Calc', description: 'CHANGED', input_schema: stableSchema },
    ])
    expect(_toolConversionCacheStatsForTesting.computes).toBe(before + 1)
    expect(out[0].function.description).toBe('CHANGED')
  })

  test('strict-mode flip recomputes instead of serving the strict-mode result', () => {
    const strictOut = convertTools(buildTools())
    const strictParams = strictOut[0].function.parameters as Record<string, unknown>
    expect(strictParams.additionalProperties).toBe(false)

    process.env.CLAUDIN_DISABLE_STRICT_TOOLS = '1'
    const before = _toolConversionCacheStatsForTesting.computes
    const looseOut = convertTools(buildTools())
    expect(_toolConversionCacheStatsForTesting.computes).toBe(before + 1)
    const looseParams = looseOut[0].function.parameters as Record<string, unknown>
    expect(looseParams.additionalProperties).toBeUndefined()
    expect(looseOut[0]).not.toBe(strictOut[0])

    // And flipping back must not serve the loose entry.
    delete process.env.CLAUDIN_DISABLE_STRICT_TOOLS
    const strictAgain = convertTools(buildTools())
    const strictAgainParams = strictAgain[0].function.parameters as Record<string, unknown>
    expect(strictAgainParams.additionalProperties).toBe(false)
  })

  test('tools without input_schema are converted fresh every time (no cache key)', () => {
    const input = [{ name: 'Bare', description: 'no schema' }]
    const out1 = convertTools(input)
    const before = _toolConversionCacheStatsForTesting.computes
    const out2 = convertTools(input)
    expect(_toolConversionCacheStatsForTesting.computes).toBe(before + 1)
    expect(out2).toEqual(out1)
  })
})
