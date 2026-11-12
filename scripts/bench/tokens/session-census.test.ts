import { describe, expect, test } from 'bun:test'
import { ALL_MODEL_CONFIGS } from 'src/providers/model/configs.js'
import { getModelCosts } from 'src/providers/usage/modelCost.js'
import { priceFor } from './session-census.ts'

// The census mirrors the app's price table because a bare script cannot load
// it (see the header of session-census.ts). This is what keeps the mirror
// honest: until 2026-10-24 Opus 5.5 and Haiku 5.5 had no row, and every census
// reported about twice the spend. The list is every registered Claude model,
// not a copy of it: Fable 5.2 shipped on 2026-11-10 with no row, fell to the
// Fable 5 one (read $1.00 where the app charges $0.20), and a hand-kept list
// had no way to notice.
const CLAUDE_MODELS = Object.values(ALL_MODEL_CONFIGS).map(config => config.firstParty)

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
