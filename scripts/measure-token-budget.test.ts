import { describe, expect, test } from 'bun:test'

import { measureTokenBudget } from './measure-token-budget.ts'

describe('measureTokenBudget', () => {
  test('returns one row per section + non-zero total per model', async () => {
    const result = await measureTokenBudget({
      engine: 'anthropic',
      models: ['claude-sonnet-4-5'],
    })

    expect(result.engine).toBe('anthropic')
    expect(result.perModel).toHaveLength(1)

    const m = result.perModel[0]!
    expect(m.model).toBe('claude-sonnet-4-5')
    expect(m.bytesPerToken).toBe(3.5)

    const sections = m.rows.map(r => r.section).sort()
    expect(sections).toEqual(['env_info', 'memory', 'system_prompt', 'tool_schemas'])

    // All sections except memory should be > 0 bytes (memory may be empty
    // when no memdir exists in CI).
    for (const r of m.rows) {
      expect(r.bytes).toBeGreaterThanOrEqual(0)
      expect(r.tokens).toBeGreaterThanOrEqual(0)
    }
    expect(m.rows.find(r => r.section === 'tool_schemas')!.bytes).toBeGreaterThan(0)
    expect(m.rows.find(r => r.section === 'system_prompt')!.bytes).toBeGreaterThan(0)
    expect(m.rows.find(r => r.section === 'env_info')!.bytes).toBeGreaterThan(0)

    expect(m.totalBytes).toBeGreaterThan(0)
    expect(m.totalTokens).toBeGreaterThan(0)
    expect(m.totalBytes).toBe(
      m.rows.reduce((acc, r) => acc + r.bytes, 0),
    )
    expect(m.totalTokens).toBe(
      m.rows.reduce((acc, r) => acc + r.tokens, 0),
    )
  })

  test('token estimates differ by model family ratio (claude 3.5 vs gpt-4 4.0)', async () => {
    const result = await measureTokenBudget({
      engine: 'anthropic',
      models: ['claude-sonnet-4-5', 'gpt-4o-2024-08-06'],
    })
    const claude = result.perModel.find(m => m.model === 'claude-sonnet-4-5')!
    const gpt = result.perModel.find(m => m.model === 'gpt-4o-2024-08-06')!

    // Byte payloads diverge slightly because env_info embeds the model
    // marketing name / id; the tool bundle and shared sections are identical
    // so the difference is small (well under 1%). What matters is the token
    // delta: Claude (3.5) packs more tokens per same bytes than GPT-4 (4.0),
    // so claude.totalTokens > gpt.totalTokens despite near-equal byte counts.
    const bytesDelta = Math.abs(claude.totalBytes - gpt.totalBytes)
    expect(bytesDelta / claude.totalBytes).toBeLessThan(0.01)
    expect(claude.totalTokens).toBeGreaterThan(gpt.totalTokens)
    expect(claude.bytesPerToken).toBe(3.5)
    expect(gpt.bytesPerToken).toBe(4)
  })

  test('engine selection changes tool_schemas bytes (different shim shape)', async () => {
    const anthropic = await measureTokenBudget({
      engine: 'anthropic',
      models: ['claude-sonnet-4-5'],
    })
    const openai = await measureTokenBudget({
      engine: 'openai',
      models: ['claude-sonnet-4-5'],
    })

    const anthropicTools = anthropic.perModel[0]!.rows.find(
      r => r.section === 'tool_schemas',
    )!.bytes
    const openaiTools = openai.perModel[0]!.rows.find(
      r => r.section === 'tool_schemas',
    )!.bytes

    expect(anthropicTools).toBeGreaterThan(0)
    expect(openaiTools).toBeGreaterThan(0)
    // Engines apply different wrappers / strict-schema rules — the totals
    // must diverge. If they collapse the shim chain regressed.
    expect(anthropicTools).not.toBe(openaiTools)
  })

  test('non-tool sections do not depend on engine choice', async () => {
    const a = await measureTokenBudget({
      engine: 'anthropic',
      models: ['claude-sonnet-4-5'],
    })
    const b = await measureTokenBudget({
      engine: 'openai',
      models: ['claude-sonnet-4-5'],
    })
    for (const section of ['system_prompt', 'memory', 'env_info'] as const) {
      const av = a.perModel[0]!.rows.find(r => r.section === section)!
      const bv = b.perModel[0]!.rows.find(r => r.section === section)!
      expect(av.bytes).toBe(bv.bytes)
      expect(av.tokens).toBe(bv.tokens)
    }
  })
})
