import { describe, expect, test } from 'bun:test'

import { measureTokenizerAccuracy } from './measure-tokenizer-accuracy.ts'

describe('measureTokenizerAccuracy', () => {
  test('returns one row per fixture with non-zero token counts', async () => {
    const result = await measureTokenizerAccuracy()
    expect(result.rows.length).toBe(6)
    for (const r of result.rows) {
      expect(r.bytes).toBeGreaterThan(0)
      expect(r.heuristicTokens).toBeGreaterThan(0)
      expect(r.referenceTokens).toBeGreaterThan(0)
    }
  })

  test('rows are sorted by drift % descending (most under-counted first)', async () => {
    const result = await measureTokenizerAccuracy()
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.driftPct).toBeGreaterThanOrEqual(
        result.rows[i]!.driftPct,
      )
    }
  })

  test('mean absolute drift excludes degenerate fixtures and stays bounded', async () => {
    const result = await measureTokenizerAccuracy()
    expect(result.meanAbsDriftPct).toBeGreaterThan(0)
    // Now that degenerate fixtures (reference < 5 tokens, e.g. pure
    // whitespace) are excluded, the mean must stay in a sane range.
    expect(result.meanAbsDriftPct).toBeLessThan(100)
  })

  test('caveat is non-empty and warns about the reference estimator', async () => {
    const result = await measureTokenizerAccuracy()
    expect(result.caveat).toContain('not a real tokenizer')
  })

  test('whitespace fixture is flagged as degenerate', async () => {
    const result = await measureTokenizerAccuracy()
    const ws = result.rows.find(r => r.contentType === 'whitespace')!
    expect(ws.isDegenerateForReference).toBe(true)
  })

  test('whitespace fixture: heuristic massively over-counts (drift ≪ 0)', async () => {
    const result = await measureTokenizerAccuracy()
    const ws = result.rows.find(r => r.contentType === 'whitespace')!
    // The 3-char-per-token assumption fails badly on pure whitespace —
    // real tokenizers compress; reference treats whole runs as 1 token.
    expect(ws.driftPct).toBeLessThan(-50)
  })

  test('JSON code fixture: drift is meaningful (heuristic miscounts symbols)', async () => {
    const result = await measureTokenizerAccuracy()
    const json = result.rows.find(r => r.contentType === 'code-json')!
    expect(Math.abs(json.driftPct)).toBeGreaterThan(5)
  })

  test('different models with different ratios produce different drifts', async () => {
    const claude = await measureTokenizerAccuracy({ model: 'claude-sonnet-4-5' })
    const gpt = await measureTokenizerAccuracy({ model: 'gpt-4o-2024-08-06' })
    // Heuristic counts diverge by ratio; reference is identical → drifts differ.
    expect(claude.bytesPerToken).toBe(3.5)
    expect(gpt.bytesPerToken).toBe(4)
    const claudeProse = claude.rows.find(r => r.fixture === 'prose')!
    const gptProse = gpt.rows.find(r => r.fixture === 'prose')!
    expect(claudeProse.heuristicTokens).not.toBe(gptProse.heuristicTokens)
  })
})
