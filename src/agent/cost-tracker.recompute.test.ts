/**
 * `recomputeCostStateFromMessages` over the shape streaming actually writes.
 *
 * One API response becomes one transcript entry PER CONTENT BLOCK
 * (`content_block_stop` in src/providers/shims/claude/streaming.ts), every one
 * spreading the message_start `usage`; `message_delta` then overwrites the
 * last one's usage with the final output count. A resumed session's replay
 * that summed every entry billed each response's input and cache terms once
 * per block — a 25-response session written as 60 entries read back 2.1× its
 * cache reads. The fixture mirrors that session's first two responses.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
  recomputeCostStateFromMessages,
  resetCostState,
} from 'src/agent/cost-tracker.js'

const MODEL = 'claude-sonnet-4-5-20250514'

type Terms = { input: number; cacheWrite1h: number; cacheRead: number }

function usage(terms: Terms, outputTokens: number): Record<string, unknown> {
  return {
    input_tokens: terms.input,
    cache_creation_input_tokens: terms.cacheWrite1h,
    cache_read_input_tokens: terms.cacheRead,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: terms.cacheWrite1h,
    },
    output_tokens: outputTokens,
  }
}

function entry(
  id: string,
  block: number,
  entryUsage: Record<string, unknown>,
  stopReason: string | null,
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `${id}-block-${block}`,
    message: {
      id,
      model: MODEL,
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id: `toolu_${id}_${block}`, name: 'Read', input: {} }],
      stop_reason: stopReason,
      usage: entryUsage,
    },
  }
}

/** `blocks` entries for one response: message_start copies, then the final. */
function response(
  id: string,
  terms: Terms,
  blocks: number,
  finalOutput: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let b = 0; b < blocks - 1; b++) out.push(entry(id, b, usage(terms, 16), null))
  out.push(entry(id, blocks - 1, usage(terms, finalOutput), 'tool_use'))
  return out
}

const A: Terms = { input: 2, cacheWrite1h: 431, cacheRead: 32_306 }
const B: Terms = { input: 2, cacheWrite1h: 1_017, cacheRead: 40_603 }

beforeEach(() => {
  resetCostState()
})

afterAll(() => {
  resetCostState()
})

describe('recomputeCostStateFromMessages — one API call per message.id', () => {
  test('several entries per message.id carrying the same usage are counted once', () => {
    const entries = [...response('msg_A', A, 3, 724), ...response('msg_B', B, 2, 817)]
    const finals = [entries[2]!, entries[4]!]

    recomputeCostStateFromMessages(finals)
    const onePerResponse = getTotalCost()

    recomputeCostStateFromMessages(entries)
    expect(getTotalCacheReadInputTokens()).toBe(A.cacheRead + B.cacheRead)
    expect(getTotalCacheCreationInputTokens()).toBe(A.cacheWrite1h + B.cacheWrite1h)
    expect(getTotalInputTokens()).toBe(A.input + B.input)
    expect(getTotalOutputTokens()).toBe(724 + 817)
    expect(getTotalCost()).toBe(onePerResponse)
  })

  test('each field takes its max over the entries, whichever entry carries it', () => {
    // The final usage first and a message_start copy after it: the sum
    // would double the cache terms, a last-wins merge would drop to 16.
    const entries = [
      entry('msg_C', 1, usage(A, 724), 'tool_use'),
      entry('msg_C', 0, usage(A, 16), null),
    ]

    recomputeCostStateFromMessages(entries)
    expect(getTotalOutputTokens()).toBe(724)
    expect(getTotalCacheReadInputTokens()).toBe(A.cacheRead)
  })
})
