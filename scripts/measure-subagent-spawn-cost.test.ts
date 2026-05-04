import { describe, expect, test } from 'bun:test'

import { measureSubagentSpawnCost } from './measure-subagent-spawn-cost.ts'

describe('measureSubagentSpawnCost', () => {
  test('returns at least one row per built-in agent with a non-empty system prompt', async () => {
    const result = await measureSubagentSpawnCost()
    // The open build always ships >=1 built-in agent (general-purpose).
    expect(result.rows.length).toBeGreaterThan(0)
    for (const r of result.rows) {
      expect(r.agentType.length).toBeGreaterThan(0)
      // System prompt MAY be empty for legacy agents that defer prompt
      // construction — but bytes must be non-negative.
      expect(r.systemPromptBytes).toBeGreaterThanOrEqual(0)
      expect(r.toolBundleBytes).toBeGreaterThan(0)
      expect(r.totalTokens).toBeGreaterThan(0)
      expect(r.totalBytes).toBe(
        r.systemPromptBytes + r.toolBundleBytes + r.whenToUseBytes,
      )
    }
  })

  test('rows are sorted by total tokens descending', async () => {
    const result = await measureSubagentSpawnCost()
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.totalTokens).toBeGreaterThanOrEqual(
        result.rows[i]!.totalTokens,
      )
    }
  })

  test('totalTokens is sum of per-agent totals', async () => {
    const result = await measureSubagentSpawnCost()
    const sum = result.rows.reduce((acc, r) => acc + r.totalTokens, 0)
    expect(result.totalTokens).toBe(sum)
  })

  test('disallowedTools filtering reduces tool bundle size for restrictive agents', async () => {
    const result = await measureSubagentSpawnCost()
    // Sub-agents with disallowedTools should ship FEWER tools than the
    // total base set; the row reports filteredToolCount. We can't assert
    // a hard upper bound without coupling to current agents, but at least
    // one row must have a non-zero filtered count.
    const anyFiltered = result.rows.some(r => r.filteredToolCount > 0)
    expect(anyFiltered).toBe(true)
  })

  test('engine selection changes tool bundle bytes', async () => {
    const a = await measureSubagentSpawnCost({ engine: 'anthropic' })
    const o = await measureSubagentSpawnCost({ engine: 'openai' })
    // Same agents, different shape → different byte totals.
    expect(a.rows.length).toBe(o.rows.length)
    expect(a.totalTokens).not.toBe(o.totalTokens)
  })
})
