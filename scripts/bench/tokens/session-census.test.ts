import { describe, expect, test } from 'bun:test'
import { getModelCosts } from 'src/providers/usage/modelCost.js'
import { priceFor } from './session-census.ts'

// The census mirrors the app's price table because a bare script cannot load
// it (see the header of session-census.ts). This is what keeps the mirror
// honest: until 2026-10-24 Opus 5.5 and Haiku 5.5 had no row, and every census
// reported about twice the spend.
const CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-fable-5-1',
]

function appRates(model: string, promptTokens: number) {
  const app = getModelCosts(model, { input_tokens: promptTokens, output_tokens: 1 } as never)
  const long = app.longPrompt && promptTokens > app.longPrompt.abovePromptTokens ? app.longPrompt : app
  return {
    input: long.inputTokens,
    write5m: long.promptCacheWriteTokens,
    write1h: long.promptCacheWrite1hTokens,
    read: long.promptCacheReadTokens,
    output: long.outputTokens,
  }
}

describe('session-census prices', () => {
  test('every Claude row matches modelCost.ts', () => {
    for (const model of CLAUDE_MODELS) {
      expect({ model, ...priceFor(model) }).toEqual({ model, ...appRates(model, 1) })
    }
  })

  test('a long prompt bills at the long-prompt tier where the app has one', () => {
    for (const model of CLAUDE_MODELS) {
      expect({ model, ...priceFor(model, 150_000) }).toEqual({ model, ...appRates(model, 150_000) })
    }
    expect(priceFor('claude-haiku-5-5', 150_000).input).toBe(0.5)
    expect(priceFor('claude-haiku-5-5', 100_000).input).toBe(0.1)
  })
})
