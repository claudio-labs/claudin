import { describe, expect, test } from 'bun:test'
import { extractTailStats } from 'src/sessions/indexing/sessionStats.js'

function assistant(
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: { role: 'assistant', model: 'm', content: [], usage },
  })
}

const agentToolResult = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [] },
  toolUseResult: {
    status: 'completed',
    usage: { input_tokens: 900_000, output_tokens: 1, cache_read_input_tokens: 0 },
  },
})

function costState(totalCostUSD: number): string {
  return JSON.stringify({
    type: 'cost-state',
    totalCostUSD,
    modelUsage: { m: { inputTokens: 700_000, outputTokens: 5 } },
  })
}

describe('extractTailStats — context tokens', () => {
  test('sums input, cache and output tokens of the last assistant line', () => {
    const tail = [
      assistant({ input_tokens: 1, output_tokens: 1 }),
      assistant({
        input_tokens: 10,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3_000,
        output_tokens: 40,
      }),
      '',
    ].join('\n')
    expect(extractTailStats(tail).contextTokens).toBe(3_250)
  })

  test("ignores an Agent tool result's usage and the cost-state totals after it", () => {
    const tail = [
      assistant({ input_tokens: 100, output_tokens: 20 }),
      agentToolResult,
      costState(1),
      '',
    ].join('\n')
    expect(extractTailStats(tail).contextTokens).toBe(120)
  })

  test('skips sidechain and zero-usage (synthetic) assistant lines', () => {
    const tail = [
      assistant({ input_tokens: 50, output_tokens: 5 }),
      assistant({ input_tokens: 999, output_tokens: 1 }, { isSidechain: true }),
      assistant({ input_tokens: 0, output_tokens: 0 }),
    ].join('\n')
    expect(extractTailStats(tail).contextTokens).toBe(55)
  })

  test('skips the truncated first line of the buffer', () => {
    const whole = assistant({ input_tokens: 7, output_tokens: 3 })
    // Cut after its opening brace, as the tail read lands mid-line.
    const cut = `"uuid":"x",${assistant({ input_tokens: 500, output_tokens: 500 }).slice(1)}`
    expect(extractTailStats(cut).contextTokens).toBeUndefined()
    expect(extractTailStats(`${cut}\n${whole}\n`).contextTokens).toBe(10)
  })
})

describe('extractTailStats — cost', () => {
  test('reads the last cost-state stamp, wherever the assistant lines sit', () => {
    const tail = [costState(1.5), assistant({ input_tokens: 1, output_tokens: 1 }), costState(22.46), ''].join('\n')
    expect(extractTailStats(tail)).toEqual({ contextTokens: 2, costUSD: 22.46 })
  })

  test('a session that never stamped its cost has none', () => {
    const tail = `${assistant({ input_tokens: 1, output_tokens: 1 })}\n`
    expect(extractTailStats(tail).costUSD).toBeUndefined()
  })

  test('is empty for a tail with neither', () => {
    expect(extractTailStats(`${agentToolResult}\n`)).toEqual({})
    expect(extractTailStats('')).toEqual({})
  })
})

describe('extractTailStats — summary', () => {
  const failedTests = JSON.stringify({
    type: 'user',
    toolUseResult: { failures: [{ message: 'Test failed', summary: 'Test failed' }] },
  })

  test('a tool result carrying a "summary" key is not the session summary', () => {
    expect(extractTailStats(`${failedTests}\n`).summary).toBeUndefined()
    // Not even on a line that holds a summary-shaped object further in.
    const quoted = JSON.stringify({
      type: 'user',
      summary: 'Quoted',
      toolUseResult: { type: 'summary', summary: 'Nested' },
    })
    expect(extractTailStats(`${quoted}\n`).summary).toBeUndefined()
  })

  test('the last summary entry is', () => {
    const tail = [
      JSON.stringify({ type: 'summary', summary: 'Old topic', leafUuid: 'a' }),
      JSON.stringify({ type: 'summary', summary: 'Resume screen redesign', leafUuid: 'b' }),
      failedTests,
      '',
    ].join('\n')
    expect(extractTailStats(tail).summary).toBe('Resume screen redesign')
  })
})
