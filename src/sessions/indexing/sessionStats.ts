/**
 * The per-session figures the session list shows beside the title, read from
 * the tail `readLiteMetadata` already holds instead of parsing the transcript:
 * the context size at the last model response, and the session's cost as its
 * last `cost-state` stamp recorded it — and the conversation summary, which a
 * `"summary":` string scrape would take from any tool result carrying that key
 * (a failed RunTests result titled a session "Test failed").
 */
import { z } from 'zod/v4'
import { jsonParse } from 'src/platform/slowOperations.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'

const ASSISTANT_LINE_MARKER = '"type":"assistant"'
const COST_STATE_LINE_MARKER = '"type":"cost-state"'
const SUMMARY_LINE_MARKER = '"type":"summary"'

const AssistantUsageLineSchema = lazySchema(() =>
  z.object({
    type: z.literal('assistant'),
    isSidechain: z.boolean().optional(),
    message: z.object({
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().nullish(),
        cache_read_input_tokens: z.number().nullish(),
      }),
    }),
  }),
)

const CostStateLineSchema = lazySchema(() =>
  z.object({
    type: z.literal('cost-state'),
    totalCostUSD: z.number(),
  }),
)

const SummaryLineSchema = lazySchema(() =>
  z.object({
    type: z.literal('summary'),
    summary: z.string(),
  }),
)

export type TailStats = {
  /** Tokens in context at the last main-thread model response. */
  contextTokens?: number
  /** The session's total cost at its last cost-state stamp (exit or switch). */
  costUSD?: number
  /** The last `summary` entry's text. */
  summary?: string
}

function parseLine(line: string): unknown {
  try {
    return jsonParse(line)
  } catch {
    // The truncated first line of the buffer; the next one up is whole.
    return undefined
  }
}

/**
 * Walks `tail` from its last line up, parsing only the lines that can answer:
 * the last main-thread assistant line (a string scrape would pick up the
 * `usage` an Agent tool result carries for its sub-agent), the last
 * cost-state stamp and the last summary entry. A synthetic message reports
 * zero usage and is skipped.
 */
export function extractTailStats(tail: string): TailStats {
  const stats: TailStats = {}
  let end = tail.length
  while (
    end > 0 &&
    (stats.contextTokens === undefined ||
      stats.costUSD === undefined ||
      stats.summary === undefined)
  ) {
    const start = tail.lastIndexOf('\n', end - 1) + 1
    const line = tail.slice(start, end)
    end = start - 1
    if (stats.contextTokens === undefined && line.includes(ASSISTANT_LINE_MARKER)) {
      const parsed = AssistantUsageLineSchema().safeParse(parseLine(line))
      if (parsed.success && !parsed.data.isSidechain) {
        const usage = parsed.data.message.usage
        const total =
          usage.input_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          usage.output_tokens
        if (total > 0) stats.contextTokens = total
      }
    } else if (stats.costUSD === undefined && line.includes(COST_STATE_LINE_MARKER)) {
      const parsed = CostStateLineSchema().safeParse(parseLine(line))
      if (parsed.success) stats.costUSD = parsed.data.totalCostUSD
    } else if (stats.summary === undefined && line.includes(SUMMARY_LINE_MARKER)) {
      const parsed = SummaryLineSchema().safeParse(parseLine(line))
      if (parsed.success) stats.summary = parsed.data.summary
    }
  }
  return stats
}
