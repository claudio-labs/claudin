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

// What a ChatGPT account offers on the Codex backend, as the copy of its
// catalog Codex CLI 0.172.0 bundles: priority order, 128k of output.
describe('codexModelCatalog — the ChatGPT account snapshot', () => {
  const ACCOUNT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

  test('codexplan names gpt-6-luna, and the snapshot lists the bundled models in priority order', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-6-luna')
    expect(getCodexAccountCatalog().map(entry => entry.id)).toEqual([
      'gpt-6.2-sol',
      'gpt-6.2-astra',
      'gpt-6.1-terra',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ])
  })

  test.each([
    ['gpt-6.2-sol', 500_000, 'low'],
    ['gpt-6.2-astra', 272_000, 'low'],
    ['gpt-6.1-terra', 500_000, 'low'],
    ['gpt-6.1-sol', 500_000, 'low'],
    ['gpt-6-astra', 272_000, 'low'],
    ['gpt-6-sol', 272_000, 'medium'],
    ['gpt-6-luna', 272_000, 'medium'],
    ['gpt-5.6-sol', 272_000, 'low'],
    ['gpt-5.6-terra', 272_000, 'medium'],
    ['gpt-5.6-luna', 272_000, 'medium'],
  ] as const)('%s: a %d window, low to max, %s by default', (id, contextWindow, defaultEffort) => {
    expect(getCodexAccountLimits(id)).toEqual({ contextWindow, effortLevels: ACCOUNT_LEVELS, defaultEffort })
  })

  test('gpt-5.5 stops at xhigh, as its catalog entry does', () => {
    expect(getCodexAccountLimits('gpt-5.5')).toEqual({
      contextWindow: 272_000,
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    })
  })

  test('a model the account catalog does not list has no account limits', () => {
    expect(getCodexAccountLimits('gpt-5.4')).toBeUndefined()
    expect(getCodexAccountLimits('unknown')).toBeUndefined()
  })

  test('the gpt-6.x models carry the API windows for API-key use', () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']) {
      expect(CODEX_CONTEXT_WINDOWS[id]).toBe(1_050_000)
      expect(CODEX_MAX_OUTPUT_TOKENS[id]).toBe(128_000)
      expect(getFilteredCodexCatalog().map(entry => entry.id)).toContain(id)
    }
  })

  test('the account-only model stays out of the API list, with the account limits in the tables', () => {
    expect(getFilteredCodexCatalog().map(entry => entry.id)).not.toContain('gpt-6-luna')
    expect(CODEX_CONTEXT_WINDOWS['gpt-6-luna']).toBe(272_000)
    expect(CODEX_MAX_OUTPUT_TOKENS['gpt-6-luna']).toBe(128_000)
    // The API numbers of the shared models do not move.
    expect(CODEX_CONTEXT_WINDOWS['gpt-5.6-terra']).toBe(1_050_000)
  })
})
