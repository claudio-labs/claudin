/**
 * The per-provider axis of the cost tracker: who each spend is billed to, and
 * that the split travels everywhere the per-model totals do — the cost-state
 * entry, the project-config slot, the session fold and the project totals.
 * A transcript replay must not invent a provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import {
  addSideQueryCost,
  addToTotalSessionCost,
  getCostStateEntryFor,
  getProjectTotals,
  getProviderUsage,
  getStoredSessionCosts,
  recomputeCostStateFromMessages,
  resetCostState,
  resetCostStateOwnerForTesting,
  restoreCostStateForResume,
  restoreStoredSessionCosts,
  saveCurrentSessionCosts,
  type SpendProvider,
} from 'src/agent/cost-tracker.js'
import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import type { ProjectConfig } from 'src/platform/config/config/types.js'
import { invalidateActiveProviderCache } from 'src/providers/presets/activeProvider.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { CostStateEntry, CostStateModelUsage } from 'src/shared/types/logs.js'

type Usage = Parameters<typeof addToTotalSessionCost>[1]

const MODEL = 'claude-opus-5-5'
const CODEX: SpendProvider = { key: 'p-codex', name: 'Codex OAuth' }
const ANTHROPIC: SpendProvider = { key: 'p-anthropic', name: 'Anthropic' }

function usage(input: number, output: number, webSearch = 0): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...(webSearch > 0 ? { server_tool_use: { web_search_requests: webSearch } } : {}),
  } as Usage
}

function modelUsage(input: number, output: number, costUSD: number): CostStateModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD,
  }
}

const SLOT_KEYS = [
  'lastSessionId',
  'lastCost',
  'lastModelUsage',
  'lastProviderUsage',
  'cumulativeCost',
  'cumulativeModelUsage',
  'cumulativeProviderUsage',
] as const satisfies ReadonlyArray<keyof ProjectConfig>
type Slot = Pick<ProjectConfig, (typeof SLOT_KEYS)[number]>

function setSlot(patch: Partial<Slot>): void {
  saveCurrentProjectConfig(current => ({ ...current, ...patch }))
}

let savedSlot: Slot
let savedSessionId: string
let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveProfileId: string | undefined

beforeAll(() => {
  const config = getCurrentProjectConfig()
  savedSlot = structuredClone(Object.fromEntries(SLOT_KEYS.map(k => [k, config[k]]))) as Slot
  savedSessionId = getSessionId()
  const global = getGlobalConfig()
  savedProfiles = global.providerProfiles
  savedActiveProfileId = global.activeProviderProfileId
})

beforeEach(() => {
  switchSession(asSessionId('provider-current'), null)
  resetCostState()
  setSlot(Object.fromEntries(SLOT_KEYS.map(k => [k, undefined])) as Slot)
})

afterAll(() => {
  resetCostState()
  setSlot(savedSlot)
  saveGlobalConfig(c => ({
    ...c,
    providerProfiles: savedProfiles,
    activeProviderProfileId: savedActiveProfileId,
  }))
  invalidateActiveProviderCache()
  switchSession(asSessionId(savedSessionId), null)
})

describe('who a spend is billed to', () => {
  test('the provider passed in, under its key and name, every field', () => {
    addToTotalSessionCost(0.5, usage(10, 20, 2), 'gpt-5.5', undefined, CODEX)
    addToTotalSessionCost(0.25, usage(1, 1), 'gpt-5.5', undefined, CODEX)
    expect(getProviderUsage()).toEqual({
      'p-codex': {
        name: 'Codex OAuth',
        models: {
          'gpt-5.5': {
            inputTokens: 11,
            outputTokens: 21,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 2,
            costUSD: 0.75,
          },
        },
      },
    })
  })

  test('the active profile by default: its id and its name', () => {
    saveGlobalConfig(c => ({
      ...c,
      providerProfiles: [
        { id: 'p-active', name: 'My Claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: MODEL },
      ],
      activeProviderProfileId: 'p-active',
    }))
    invalidateActiveProviderCache()
    try {
      addToTotalSessionCost(1, usage(1, 1), MODEL)
      addSideQueryCost(0.5, usage(1, 1), MODEL, 'auto_mode')
      expect(Object.keys(getProviderUsage())).toEqual(['p-active'])
      expect(getProviderUsage()['p-active']?.name).toBe('My Claude')
      expect(getProviderUsage()['p-active']?.models[MODEL]?.costUSD).toBeCloseTo(1.5)
    } finally {
      saveGlobalConfig(c => ({ ...c, providerProfiles: savedProfiles, activeProviderProfileId: savedActiveProfileId }))
      invalidateActiveProviderCache()
    }
  })

  test('with no profile at all: an env key named for the transport', () => {
    saveGlobalConfig(c => ({ ...c, providerProfiles: [], activeProviderProfileId: undefined }))
    invalidateActiveProviderCache()
    try {
      addToTotalSessionCost(1, usage(1, 1), MODEL)
      expect(getProviderUsage()).toEqual({
        'env:firstParty': { name: 'Anthropic', models: { [MODEL]: modelUsage(1, 1, 1) } },
      })
    } finally {
      saveGlobalConfig(c => ({ ...c, providerProfiles: savedProfiles, activeProviderProfileId: savedActiveProfileId }))
      invalidateActiveProviderCache()
    }
  })

  test('a later spend renames the bucket to the profile name it has now', () => {
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, ANTHROPIC)
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, { ...ANTHROPIC, name: 'Claude Max' })
    expect(getProviderUsage()['p-anthropic']?.name).toBe('Claude Max')
  })

  test('null bills nobody: the per-model totals still count it', () => {
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, null)
    expect(getProviderUsage()).toEqual({})
  })

  test('a transcript replay records per model only', () => {
    recomputeCostStateFromMessages([
      { type: 'assistant', message: { id: 'r1', model: MODEL, usage: { input_tokens: 5, output_tokens: 5 } } },
    ])
    expect(getProviderUsage()).toEqual({})
    expect(getProjectTotals().modelUsage[MODEL]?.inputTokens).toBe(5)
  })

  test('resetCostState clears the split', () => {
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, ANTHROPIC)
    resetCostState()
    expect(getProviderUsage()).toEqual({})
  })
})

describe('the split travels with the totals', () => {
  test('the cost-state entry carries it, and a resume puts it back', () => {
    resetCostStateOwnerForTesting()
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, ANTHROPIC)
    const entry = getCostStateEntryFor('provider-current') as CostStateEntry
    expect(entry.providerUsage).toEqual(getProviderUsage())

    resetCostState()
    restoreCostStateForResume('provider-current', { costState: entry, messages: [] })
    expect(getProviderUsage()).toEqual(entry.providerUsage!)
  })

  test('an entry written before the split restores to none', () => {
    resetCostStateOwnerForTesting()
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, ANTHROPIC)
    const { providerUsage: _dropped, ...legacy } = getCostStateEntryFor('provider-current') as CostStateEntry
    resetCostState()
    restoreCostStateForResume('provider-current', { costState: legacy as CostStateEntry, messages: [] })
    expect(getProviderUsage()).toEqual({})
  })

  test('the project-config slot keeps it, and restoring the slot puts it back', () => {
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, CODEX)
    saveCurrentSessionCosts()
    expect(getCurrentProjectConfig().lastProviderUsage).toEqual(getProviderUsage())

    const stored = getStoredSessionCosts('provider-current')!
    resetCostState()
    restoreStoredSessionCosts(stored)
    expect(getProviderUsage()).toEqual({
      'p-codex': { name: 'Codex OAuth', models: { [MODEL]: modelUsage(1, 1, 1) } },
    })
  })

  test('a new session folds the closed one into the cumulative split', () => {
    setSlot({
      lastSessionId: 'provider-previous',
      lastProviderUsage: {
        'p-codex': { name: 'Codex (renamed)', models: { 'gpt-5.5': modelUsage(2, 2, 0.5) } },
        'p-gone': { name: 'Z.ai', models: { 'glm-5.2': modelUsage(1, 0, 0.1) } },
      },
      cumulativeProviderUsage: {
        'p-codex': { name: 'Codex OAuth', models: { 'gpt-5.5': modelUsage(1, 1, 0.25) } },
      },
    })
    addToTotalSessionCost(1, usage(1, 1), MODEL, undefined, ANTHROPIC)
    saveCurrentSessionCosts()

    const c = getCurrentProjectConfig()
    expect(c.cumulativeProviderUsage).toEqual({
      'p-codex': { name: 'Codex (renamed)', models: { 'gpt-5.5': modelUsage(3, 3, 0.75) } },
      'p-gone': { name: 'Z.ai', models: { 'glm-5.2': modelUsage(1, 0, 0.1) } },
    })
    expect(c.lastProviderUsage).toEqual({
      'p-anthropic': { name: 'Anthropic', models: { [MODEL]: modelUsage(1, 1, 1) } },
    })

    // The same session saving again folds nothing twice.
    saveCurrentSessionCosts()
    expect(getCurrentProjectConfig().cumulativeProviderUsage?.['p-codex']?.models['gpt-5.5']).toEqual(
      modelUsage(3, 3, 0.75),
    )
  })

  test('project totals: cumulative + the pending closed session + live', () => {
    setSlot({
      lastSessionId: 'provider-previous',
      lastProviderUsage: { 'p-codex': { name: 'Codex OAuth', models: { 'gpt-5.5': modelUsage(2, 2, 0.5) } } },
      cumulativeProviderUsage: { 'p-codex': { name: 'Codex OAuth', models: { 'gpt-5.5': modelUsage(1, 1, 0.25) } } },
    })
    addToTotalSessionCost(1, usage(1, 1), 'gpt-5.5', undefined, CODEX)
    const totals = getProjectTotals()
    expect(totals.providerUsage['p-codex']?.models['gpt-5.5']).toEqual(modelUsage(4, 4, 1.75))
    // Read-only: the slot on disk is untouched.
    expect(getCurrentProjectConfig().cumulativeProviderUsage?.['p-codex']?.models['gpt-5.5']).toEqual(
      modelUsage(1, 1, 0.25),
    )
  })

  test('project totals without any recorded split', () => {
    expect(getProjectTotals().providerUsage).toEqual({})
  })
})
