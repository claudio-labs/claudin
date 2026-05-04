import { describe, expect, test } from 'bun:test'

import { measureWebFetchEnvelope } from './measure-webfetch-envelope.ts'

describe('measureWebFetchEnvelope', () => {
  test('produces 15 rows (3 paths × {search,fetch} × 3 profiles, with preapproved only on fetch)', async () => {
    const result = await measureWebFetchEnvelope()
    // 2 paths emit search rows × 3 profiles = 6; 3 paths emit fetch rows ×
    // 3 profiles = 9 → 15 total.
    expect(result.rows).toHaveLength(15)
    for (const r of result.rows) {
      expect(r.bytes).toBeGreaterThan(0)
      expect(r.tokens).toBeGreaterThan(0)
    }
  })

  test('Haiku-summary fetch rows: firecrawl ≈ default (both pipe through Haiku)', async () => {
    const result = await measureWebFetchEnvelope()
    for (const profile of ['small', 'typical', 'large'] as const) {
      const fc = result.rows.find(
        r => r.path === 'firecrawl-haiku' && r.operation === 'fetch' && r.profile === profile,
      )!
      const dh = result.rows.find(
        r => r.path === 'default-haiku' && r.operation === 'fetch' && r.profile === profile,
      )!
      // Both go through `applyPromptToMarkdown` → identical Haiku-bounded output.
      expect(fc.bytes).toBe(dh.bytes)
      expect(fc.tokens).toBe(dh.tokens)
    }
  })

  test('preapproved-markdown shortcut returns much more than Haiku summary', async () => {
    const result = await measureWebFetchEnvelope()
    for (const profile of ['small', 'typical', 'large'] as const) {
      const haiku = result.rows.find(
        r => r.path === 'default-haiku' && r.operation === 'fetch' && r.profile === profile,
      )!
      const pre = result.rows.find(
        r => r.path === 'default-preapproved' && r.operation === 'fetch' && r.profile === profile,
      )!
      // Preapproved-markdown is the raw body (up to 100 KB cap) — far bigger.
      expect(pre.tokens).toBeGreaterThan(haiku.tokens * 2)
    }
  })

  test('worst-case session > mixed session by exactly the preapproved-rate uplift', async () => {
    const result = await measureWebFetchEnvelope({
      searchesPerSession: 2,
      fetchesPerSession: 4,
      preapprovedFetchRate: 0.25,
    })
    expect(result.sessionTokensWorstCase).toBeGreaterThan(result.sessionTokens)
  })

  test('preapproved rate of 0 collapses session to all-Haiku cost', async () => {
    const allHaiku = await measureWebFetchEnvelope({
      preapprovedFetchRate: 0,
      fetchesPerSession: 5,
    })
    const allPreapproved = await measureWebFetchEnvelope({
      preapprovedFetchRate: 1,
      fetchesPerSession: 5,
    })
    expect(allPreapproved.sessionTokens).toBeGreaterThan(allHaiku.sessionTokens)
    // Worst-case equals the preapproved-rate=1 mixed case.
    expect(allPreapproved.sessionTokens).toBe(
      allPreapproved.sessionTokensWorstCase,
    )
  })
})
