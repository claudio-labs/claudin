import { describe, expect, test } from 'bun:test'

import { measureAttachmentBudget } from './measure-attachments-budget.ts'

describe('measureAttachmentBudget', () => {
  test('produces a populated, descending-by-bytes table', async () => {
    const result = await measureAttachmentBudget({
      model: 'claude-sonnet-4-5',
      profile: 'typical',
    })

    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.bytesPerToken).toBe(3.5)
    expect(result.profile).toBe('typical')
    expect(result.rows.length).toBeGreaterThan(20)

    const nonEmpty = result.rows.filter(r => !r.empty)
    expect(nonEmpty.length).toBeGreaterThan(15)

    // Sorted descending by bytes.
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i - 1]!.bytes).toBeGreaterThanOrEqual(result.rows[i]!.bytes)
    }

    // Total is consistent with row sum.
    expect(result.totalBytes).toBe(
      result.rows.reduce((acc, r) => acc + r.bytes, 0),
    )
    expect(result.totalTokens).toBe(
      result.rows.reduce((acc, r) => acc + r.tokens, 0),
    )

    // The bash_git_instructions and plan_mode renderers always emit substantial
    // wire content (their text is big static blocks). If either drops to 0
    // bytes the renderer or its gating regressed.
    const bashGit = result.rows.find(r => r.kind === 'bash_git_instructions')
    expect(bashGit).toBeDefined()
    expect(bashGit!.bytes).toBeGreaterThan(500)
  })

  test('heavy profile is strictly larger than typical for the same fixtures', async () => {
    const typical = await measureAttachmentBudget({ profile: 'typical' })
    const heavy = await measureAttachmentBudget({ profile: 'heavy' })
    expect(heavy.totalBytes).toBeGreaterThan(typical.totalBytes)
    expect(heavy.totalTokens).toBeGreaterThan(typical.totalTokens)
  })

  test('token estimate scales with bytes/token ratio of the chosen model', async () => {
    const claude = await measureAttachmentBudget({
      model: 'claude-sonnet-4-5',
      profile: 'typical',
    })
    const gpt = await measureAttachmentBudget({
      model: 'gpt-4o-2024-08-06',
      profile: 'typical',
    })
    // Same renderer output (renderer is model-agnostic) → identical bytes.
    expect(claude.totalBytes).toBe(gpt.totalBytes)
    // Claude (3.5) packs more tokens per same bytes than GPT-4 (4.0).
    expect(claude.totalTokens).toBeGreaterThan(gpt.totalTokens)
  })

  test('every row reports nonneg numbers and a string kind', async () => {
    const result = await measureAttachmentBudget({ profile: 'typical' })
    for (const r of result.rows) {
      expect(typeof r.kind).toBe('string')
      expect(r.bytes).toBeGreaterThanOrEqual(0)
      expect(r.tokens).toBeGreaterThanOrEqual(0)
      expect(r.wireMessages).toBeGreaterThanOrEqual(0)
    }
  })
})
