import { describe, expect, test } from 'bun:test'
import {
  CODEX_CONTEXT_WINDOWS,
  CODEX_DEFAULT_MODEL,
  CODEX_MAX_OUTPUT_TOKENS,
  CODEX_MODEL_CATALOG,
  getCodexAccountCatalog,
  getCodexAccountLimits,
  getFilteredCodexCatalog,
  isCodexModelAllowed,
} from 'src/providers/model/codexModelCatalog.js'

describe('codexModelCatalog — the pro rule (opencode parity)', () => {
  test('includes the models opencode allowlists', () => {
    for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(isCodexModelAllowed(id)).toBe(true)
    }
  })

  test('excludes pro variants (disallowlist + -pro suffix)', () => {
    expect(isCodexModelAllowed('gpt-5.5-pro')).toBe(false)
    expect(isCodexModelAllowed('gpt-6.0-pro')).toBe(false)
    // isPro flag mirrors opencode's reasoningMode === "pro"
    expect(isCodexModelAllowed('gpt-5.5', { isPro: true })).toBe(false)
  })
})

describe('codexModelCatalog — Claudin divergences', () => {
  test('gpt-5.6 tiers are ENABLED (opencode excludes gpt-5.6)', () => {
    const filtered = getFilteredCodexCatalog().map(e => e.id)
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(isCodexModelAllowed(id)).toBe(true)
      expect(filtered).toContain(id)
    }
    // Bare `gpt-5.6` is a resolution-only alias (→ sol), not a picker entry.
    expect(filtered).not.toContain('gpt-5.6')
  })

  test('older codex-branded models stay in the picker', () => {
    for (const id of ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini']) {
      expect(isCodexModelAllowed(id)).toBe(true)
    }
  })
})

describe('codexModelCatalog — picker + derived maps', () => {
  test('the API list is every catalog entry but the account-only ones', () => {
    const apiIds = CODEX_MODEL_CATALOG.filter(e => !e.accountOnly).map(e => e.id)
    expect(getFilteredCodexCatalog().map(e => e.id)).toEqual(apiIds)
  })

  test('every filtered entry has a label and description', () => {
    for (const entry of getFilteredCodexCatalog()) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  test('context maps use the official OpenAI descriptor windows', () => {
    // gpt-5.5/5.6 carry the official 1.05M input / 128k output descriptors.
    expect(CODEX_CONTEXT_WINDOWS['gpt-5.5']).toBe(1_050_000)
    expect(CODEX_CONTEXT_WINDOWS['gpt-5.6-sol']).toBe(1_050_000)
    expect(CODEX_MAX_OUTPUT_TOKENS['gpt-5.6-sol']).toBe(128_000)
    // codex-branded models without a declared window stay absent (default budget)
    expect(CODEX_CONTEXT_WINDOWS['gpt-5.3-codex']).toBeUndefined()
  })
})

// What a ChatGPT account offers on the Codex backend (its own catalog,
// 2026-10-16): three models, 272k of window, 128k of output.
describe('codexModelCatalog — the ChatGPT account', () => {
  test('codexplan names the Codex CLI default, and it leads the account list', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-6-luna')
    expect(getCodexAccountCatalog().map(entry => entry.id)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  })

  test('account limits for the account models only', () => {
    for (const id of ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getCodexAccountLimits(id)).toEqual({
        contextWindow: 272_000,
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      })
    }
    expect(getCodexAccountLimits('gpt-5.6-sol')).toBeUndefined()
    expect(getCodexAccountLimits('gpt-5.5')).toBeUndefined()
    expect(getCodexAccountLimits('unknown')).toBeUndefined()
  })

  test('the account-only model stays out of the API list, with the account limits in the tables', () => {
    expect(getFilteredCodexCatalog().map(entry => entry.id)).not.toContain('gpt-6-luna')
    expect(CODEX_CONTEXT_WINDOWS['gpt-6-luna']).toBe(272_000)
    expect(CODEX_MAX_OUTPUT_TOKENS['gpt-6-luna']).toBe(128_000)
    // The API numbers of the shared models do not move.
    expect(CODEX_CONTEXT_WINDOWS['gpt-5.6-terra']).toBe(1_050_000)
  })
})
