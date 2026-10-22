import { describe, expect, test } from 'bun:test'

import {
  attributeModel,
  groupUsageByProvider,
  OTHERS_KEY,
  type AttributionProfile,
} from 'src/providers/usage/providerAttribution.js'
import type { CostStateModelUsage } from 'src/shared/types/logs.js'

function usage(partial: Partial<CostStateModelUsage>): CostStateModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    ...partial,
  }
}

// The registered profiles of the user this feature was built for (models
// trimmed to what the cases need).
const ANTHROPIC: AttributionProfile = {
  id: 'p-anthropic',
  name: 'Anthropic',
  kind: 'firstParty',
  baseUrl: 'https://api.anthropic.com',
  models: [],
}
const CODEX: AttributionProfile = {
  id: 'p-codex',
  name: 'Codex OAuth',
  kind: 'codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  models: ['codexplan'],
}
const OPENCODE: AttributionProfile = {
  id: 'p-opencode',
  name: 'OpenCode GO',
  kind: 'openai',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  models: ['glm-5.3-flash', 'claude-haiku-5-5', 'glm-5.1', 'glm-5.2', 'gpt-5.6-luna'],
}
const MOONSHOT: AttributionProfile = {
  id: 'p-moonshot',
  name: 'Moonshot AI',
  kind: 'openai',
  baseUrl: 'https://api.kimi.com/coding/v1',
  models: ['k3', 'kimi-for-coding'],
}
const OPENROUTER: AttributionProfile = {
  id: 'p-openrouter',
  name: 'OpenRouter',
  kind: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  models: ['openai/gpt-5-mini', '~anthropic/claude-opus-latest'],
}
const PROFILES = [OPENCODE, CODEX, MOONSHOT, OPENROUTER, ANTHROPIC]

describe('attributeModel', () => {
  test.each([
    ['claude-opus-5-5', 'p-anthropic'],
    // Listed by the OpenCode gateway too: the family's own backend wins.
    ['claude-haiku-5-5', 'p-anthropic'],
    ['gpt-5.5', 'p-codex'],
    ['codex-mini', 'p-codex'],
    ['glm-5.1', 'p-opencode'],
    ['k3', 'p-moonshot'],
    ['openai/gpt-5-mini', 'p-openrouter'],
    // Vendor-prefixed but not in any listing: the OpenRouter profile.
    ['qwen/qwen3.8-max-0902', 'p-openrouter'],
    ['~anthropic/claude-opus-latest', 'p-openrouter'],
  ])('%s → %s', (model, expected) => {
    expect(attributeModel(model, PROFILES)).toBe(expected)
  })

  test('a model nobody lists has no owner', () => {
    expect(attributeModel('minimax-m3', PROFILES)).toBeUndefined()
  })

  test('a model two non-family profiles list is ambiguous', () => {
    const other = { ...MOONSHOT, id: 'p-other', models: ['glm-5.1'] }
    expect(attributeModel('glm-5.1', [OPENCODE, other])).toBeUndefined()
  })

  test('a family with no backend registered falls back to the listing', () => {
    expect(attributeModel('claude-haiku-5-5', [OPENCODE, MOONSHOT])).toBe(
      'p-opencode',
    )
  })

  test('two backends of one family: the one listing the model wins', () => {
    const second = { ...ANTHROPIC, id: 'p-anthropic-2', models: ['claude-sonnet-5'] }
    expect(attributeModel('claude-sonnet-5', [ANTHROPIC, second])).toBe(
      'p-anthropic-2',
    )
    expect(attributeModel('claude-opus-5', [ANTHROPIC, second])).toBe(
      'p-anthropic',
    )
  })

  test('a vendor-prefixed id with no listing and no OpenRouter has no owner', () => {
    expect(attributeModel('z-ai/glm-5.3-flash', [ANTHROPIC, CODEX])).toBeUndefined()
  })
})

describe('groupUsageByProvider', () => {
  test('every registered profile gets a group, in config order, even with no spend', () => {
    const groups = groupUsageByProvider({
      modelUsage: {},
      providerUsage: {},
      profiles: PROFILES,
      activeKey: 'p-anthropic',
    })
    expect(groups.map(g => g.key)).toEqual(PROFILES.map(p => p.id))
    expect(groups.find(g => g.active)?.key).toBe('p-anthropic')
    expect(groups.every(g => g.totalCostUSD === 0)).toBe(true)
  })

  test('recorded spend is exact; only the unclaimed rest is estimated', () => {
    const groups = groupUsageByProvider({
      modelUsage: {
        'claude-haiku-5-5': usage({ inputTokens: 100, costUSD: 1 }),
      },
      providerUsage: {
        'p-opencode': {
          name: 'OpenCode GO',
          models: { 'claude-haiku-5-5': usage({ inputTokens: 30, costUSD: 0.25 }) },
        },
      },
      profiles: PROFILES,
    })
    const opencode = groups.find(g => g.key === 'p-opencode')!
    const anthropic = groups.find(g => g.key === 'p-anthropic')!
    expect(opencode.exact['claude-haiku-5-5']?.inputTokens).toBe(30)
    expect(opencode.estimated).toEqual({})
    expect(anthropic.exact).toEqual({})
    expect(anthropic.estimated['claude-haiku-5-5']?.inputTokens).toBe(70)
    expect(anthropic.totalCostUSD).toBeCloseTo(0.75)
    expect(opencode.totalCostUSD).toBeCloseTo(0.25)
  })

  test('a fully recorded model leaves nothing to estimate (float noise included)', () => {
    const groups = groupUsageByProvider({
      modelUsage: { 'gpt-5.5': usage({ outputTokens: 3, costUSD: 0.1 + 0.2 }) },
      providerUsage: {
        'p-codex': { name: 'Codex OAuth', models: { 'gpt-5.5': usage({ outputTokens: 3, costUSD: 0.3 }) } },
      },
      profiles: PROFILES,
    })
    expect(groups.some(g => Object.keys(g.estimated).length > 0)).toBe(false)
    expect(groups.some(g => g.key === OTHERS_KEY)).toBe(false)
  })

  test('unattributable spend lands in Others, last', () => {
    const groups = groupUsageByProvider({
      modelUsage: { 'minimax-m3': usage({ inputTokens: 5, costUSD: 0.09 }) },
      providerUsage: {},
      profiles: PROFILES,
    })
    const last = groups.at(-1)!
    expect(last.key).toBe(OTHERS_KEY)
    expect(last.kind).toBe('others')
    expect(last.name).toBe('Others')
    expect(last.estimated['minimax-m3']?.costUSD).toBeCloseTo(0.09)
  })

  test('spend recorded for a deleted profile keeps its recorded name', () => {
    const groups = groupUsageByProvider({
      modelUsage: { 'glm-5.2': usage({ inputTokens: 1, costUSD: 0.5 }) },
      providerUsage: {
        'p-gone': { name: 'Z.ai', models: { 'glm-5.2': usage({ inputTokens: 1, costUSD: 0.5 }) } },
      },
      profiles: PROFILES,
    })
    const gone = groups.find(g => g.key === 'p-gone')!
    expect(gone.kind).toBe('removed')
    expect(gone.name).toBe('Z.ai')
    expect(gone.totalCostUSD).toBeCloseTo(0.5)
    // After the registered profiles, before Others.
    expect(groups.indexOf(gone)).toBe(PROFILES.length)
  })

  test('spend made without a profile is an env group, not a removed one', () => {
    const groups = groupUsageByProvider({
      modelUsage: {},
      providerUsage: { 'env:firstParty': { name: 'Anthropic', models: {} } },
      profiles: [],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe('env')
  })

  test('the same model recorded under two providers sums per provider', () => {
    const groups = groupUsageByProvider({
      modelUsage: { 'claude-opus-5-5': usage({ inputTokens: 10, costUSD: 2 }) },
      providerUsage: {
        'p-anthropic': { name: 'Anthropic', models: { 'claude-opus-5-5': usage({ inputTokens: 6, costUSD: 1.2 }) } },
        'p-openrouter': { name: 'OpenRouter', models: { 'claude-opus-5-5': usage({ inputTokens: 4, costUSD: 0.8 }) } },
      },
      profiles: PROFILES,
    })
    expect(groups.find(g => g.key === 'p-anthropic')!.totalCostUSD).toBeCloseTo(1.2)
    expect(groups.find(g => g.key === 'p-openrouter')!.totalCostUSD).toBeCloseTo(0.8)
    expect(groups.some(g => Object.keys(g.estimated).length > 0)).toBe(false)
  })
})
