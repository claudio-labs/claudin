import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as React from 'react'

import { recordBytesSaved, resetBytesSaved } from 'src/agent/context/tokensSaved.js'
import {
  lastFrame,
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import type { CostStateProviderUsage } from 'src/shared/types/logs.js'

type ModelUsageRecord = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}
type PlainUsage = Omit<ModelUsageRecord, 'contextWindow' | 'maxOutputTokens'>

let totalCost = 0
let totalAPIDuration = 0
let totalDuration = 0
let totalLinesAdded = 0
let totalLinesRemoved = 0
let modelUsage: Record<string, ModelUsageRecord> = {}
let providerUsage: Record<string, CostStateProviderUsage> = {}
let unknownCost = false
let projectTotals: {
  totalCost: number
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  modelUsage: Record<string, PlainUsage>
  providerUsage: Record<string, CostStateProviderUsage>
} = emptyTotals()

function emptyTotals(): typeof projectTotals {
  return {
    totalCost: 0,
    totalAPIDuration: 0,
    totalDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    modelUsage: {},
    providerUsage: {},
  }
}

const realCostTracker = { ...(await import('src/agent/cost-tracker.js')) }

mock.module('src/agent/cost-tracker.js', () => ({
  ...realCostTracker,
  getTotalCost: () => totalCost,
  getTotalAPIDuration: () => totalAPIDuration,
  getTotalDuration: () => totalDuration,
  getTotalLinesAdded: () => totalLinesAdded,
  getTotalLinesRemoved: () => totalLinesRemoved,
  getModelUsage: () => modelUsage,
  getProviderUsage: () => providerUsage,
  hasUnknownModelCost: () => unknownCost,
  getProjectTotals: () => projectTotals,
}))

const { getGlobalConfig, saveGlobalConfig } = await import('src/platform/config/config.js')
const { invalidateActiveProviderCache } = await import('src/providers/presets/activeProvider.js')
const providerLimits = await import('src/providers/usage/providerLimits.js')
const { Usage } = await import('src/platform/settings/ui/Usage.js')

const PROFILES = [
  { id: 'p-anthropic', name: 'Anthropic', provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: '' },
  { id: 'p-codex', name: 'Codex OAuth', provider: 'openai' as const, baseUrl: 'https://chatgpt.com/backend-api/codex', model: 'codexplan' },
  { id: 'p-router', name: 'OpenRouter', provider: 'openai' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' },
]

let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveId: string | undefined

function setProfiles(profiles: typeof PROFILES, activeId?: string): void {
  saveGlobalConfig(c => ({ ...c, providerProfiles: profiles, activeProviderProfileId: activeId }))
  invalidateActiveProviderCache()
}

function plain(partial: Partial<PlainUsage>): PlainUsage {
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

function makeUsage(partial: Partial<ModelUsageRecord>): ModelUsageRecord {
  return { ...plain(partial), contextWindow: 0, maxOutputTokens: 0, ...partial }
}

function resetState() {
  totalCost = 0
  totalAPIDuration = 0
  totalDuration = 0
  totalLinesAdded = 0
  totalLinesRemoved = 0
  modelUsage = {}
  providerUsage = {}
  unknownCost = false
  resetBytesSaved()
  projectTotals = emptyTotals()
}

const fetched: string[] = []
let fetcherSpy: ReturnType<typeof spyOn<typeof providerLimits, 'getLimitsFetcher'>>

/**
 * Mounts the tab on a real root: its keybindings need an input stream, and a
 * static render would show neither a resolved fetch nor a key press.
 */
async function mount(view: 'global' | 'session') {
  const mounted = await mountHook(
    <AppStateProvider>
      <KeybindingSetup>
        <Usage view={view} />
      </KeybindingSetup>
    </AppStateProvider>,
    { columns: 140 },
  )
  const frame = () => lastFrame(mounted.streams.getOutput())
  return {
    frame,
    press: (sequence: string) => mounted.streams.stdin.write(sequence),
    until: (predicate: (frame: string) => boolean, label: string) =>
      waitForCondition(() => predicate(frame()), { label }),
    cleanup: mounted.cleanup,
  }
}

/** Render, wait for `text`, and hand back the frame. */
async function renderUntil(view: 'global' | 'session', text: string): Promise<string> {
  const ui = await mount(view)
  try {
    await ui.until(f => f.includes(text), text)
    return ui.frame()
  } finally {
    await ui.cleanup()
  }
}

beforeAll(() => {
  const config = getGlobalConfig()
  savedProfiles = config.providerProfiles
  savedActiveId = config.activeProviderProfileId
  // No network: every limits read is recorded and answered locally.
  fetcherSpy = spyOn(providerLimits, 'getLimitsFetcher').mockImplementation(
    () => async profile => {
      fetched.push(profile.profileId ?? '?')
      return { rows: [] }
    },
  )
})

beforeEach(() => {
  resetState()
  fetched.length = 0
  setProfiles([], undefined)
})

afterEach(resetState)

afterAll(() => {
  fetcherSpy.mockRestore()
  saveGlobalConfig(c => ({ ...c, providerProfiles: savedProfiles, activeProviderProfileId: savedActiveId }))
  invalidateActiveProviderCache()
  mock.module('src/agent/cost-tracker.js', () => realCostTracker)
})

describe('<Usage view="session" />', () => {
  it('renders nothing when there is no usage in the session', async () => {
    const ui = await mount('session')
    try {
      await Bun.sleep(150)
      // Nothing painted: only the terminal's own control sequences remain.
      expect(ui.frame()).not.toContain('Current session')
      expect(ui.frame()).not.toContain('scroll')
    } finally {
      await ui.cleanup()
    }
  })

  it('renders the totals, then each provider with its models', async () => {
    setProfiles(PROFILES, 'p-anthropic')
    totalCost = 0.0008
    totalAPIDuration = 6000
    totalDuration = 156000
    modelUsage = { 'claude-haiku-4-5-20251001': makeUsage({ inputTokens: 680, outputTokens: 25, costUSD: 0.0008 }) }
    providerUsage = {
      'p-anthropic': { name: 'Anthropic', models: { 'claude-haiku-4-5-20251001': plain({ inputTokens: 680, outputTokens: 25, costUSD: 0.0008 }) } },
    }

    const output = await renderUntil('session', 'Usage by provider:')

    expect(output).toContain('Current session')
    expect(output).toContain('Total cost:            $0.0008')
    expect(output).toContain('Total duration (API):  6s')
    expect(output).toContain('Total duration (wall): 2m 36s')
    expect(output).toContain('Total code changes:    0 lines added, 0 lines removed')
    expect(output).toContain('Anthropic ● · $0.0008')
    expect(output).toContain('claude-haiku-4-5  $0.0008  680 input, 25 output')
    expect(output).not.toContain('cache read')
    expect(output).not.toContain('~')
  })

  it('includes cache and web search only when those counts are non-zero', async () => {
    totalCost = 0.103
    totalLinesAdded = 1
    totalLinesRemoved = 2
    modelUsage = {
      'claude-opus-4-7-20251101': makeUsage({
        inputTokens: 6,
        outputTokens: 25,
        cacheReadInputTokens: 15900,
        cacheCreationInputTokens: 15100,
        webSearchRequests: 3,
        costUSD: 0.103,
      }),
    }

    const output = await renderUntil('session', 'web search')

    expect(output).toContain('Total code changes:    1 line added, 2 lines removed')
    expect(output).toContain('15.9k cache read, 15.1k cache write, 3 web search')
  })

  it('shows the Context tokens saved line when bytes were saved', async () => {
    totalCost = 0.01
    modelUsage = { 'claude-opus-4-7-20251101': makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.01 }) }
    recordBytesSaved(4_000_000, 0) // 4 MB → ~1m tokens

    expect(await renderUntil('session', 'Current session')).toContain('Context tokens saved:')
  })

  it('hides the line when nothing was saved', async () => {
    totalCost = 0.01
    modelUsage = { 'claude-opus-4-7-20251101': makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.01 }) }

    expect(await renderUntil('session', 'Current session')).not.toContain('Context tokens saved')
  })

  it('appends the unknown-cost warning when hasUnknownModelCost is true', async () => {
    modelUsage = { 'mystery-model': makeUsage({ inputTokens: 10, outputTokens: 5 }) }
    unknownCost = true

    expect(await renderUntil('session', 'Current session')).toContain(
      'costs may be inaccurate due to usage of unknown models',
    )
  })
})

describe('<Usage view="global" />', () => {
  it('with no profile it opens on All: totals and the provider split', async () => {
    projectTotals = {
      ...emptyTotals(),
      totalCost: 1.23,
      totalAPIDuration: 60000,
      totalDuration: 600000,
      totalLinesAdded: 42,
      totalLinesRemoved: 7,
      modelUsage: { 'claude-opus-4-7-20251101': plain({ inputTokens: 5000, outputTokens: 2500, costUSD: 1.23 }) },
    }
    recordBytesSaved(4_000_000, 0)

    const output = await renderUntil('global', "What's driving your token usage?")

    expect(output).toContain(' All ')
    expect(output).toContain('Project total (all sessions)')
    expect(output).toContain('$1.23')
    expect(output).toContain('42 lines added, 7 lines removed')
    expect(output).toContain('Usage by provider:')
    // Nobody to attribute it to: estimated, under Others.
    expect(output).toContain('~ Others  $1.23  5.0k input, 2.5k output')
    expect(output).toContain('d/w day/week')
    // The project view never shows the session-only line.
    expect(output).not.toContain('Context tokens saved')
    expect(fetched).toEqual([])
  })

  it('opens on the active profile and reads only its limits', async () => {
    setProfiles(PROFILES, 'p-anthropic')
    projectTotals = {
      ...emptyTotals(),
      totalCost: 3,
      modelUsage: {
        'claude-opus-5-5': plain({ inputTokens: 10, costUSD: 2 }),
        'openai/gpt-5-mini': plain({ inputTokens: 5, costUSD: 1 }),
      },
      providerUsage: {
        'p-anthropic': { name: 'Anthropic', models: { 'claude-opus-5-5': plain({ inputTokens: 4, costUSD: 0.5 }) } },
      },
    }

    const output = await renderUntil('global', 'No limit data was returned')

    expect(output).toContain(' All │ Anthropic ● │ Codex OAuth │ OpenRouter')
    expect(output).toContain('Anthropic · active')
    expect(output).toContain('Usage in this project (all sessions)')
    // Recorded and estimated parts of one model, one row, marked.
    expect(output).toContain('~ claude-opus-5-5  $2.00')
    expect(output).not.toContain('gpt-5-mini')
    expect(output).toContain('[ ] provider')
    expect(output).not.toContain('d/w day/week')
    expect(fetched).toEqual(['p-anthropic'])
  })

  it('] and [ step through the chips; each provider is read once, when first shown', async () => {
    setProfiles(PROFILES, 'p-anthropic')
    projectTotals = {
      ...emptyTotals(),
      modelUsage: { 'openai/gpt-5-mini': plain({ inputTokens: 5, costUSD: 1 }) },
    }
    const ui = await mount('global')
    try {
      await ui.until(f => f.includes('Anthropic · active'), 'the active chip')
      ui.press(']')
      await ui.until(f => f.includes('Codex OAuth') && !f.includes('Anthropic · active') && f.includes('No limit data'), 'Codex')
      ui.press(']')
      await ui.until(f => f.includes('~ openai/gpt-5-mini'), 'OpenRouter, with its estimated spend')
      ui.press(']')
      await ui.until(f => f.includes('Project total (all sessions)'), 'All, after wrapping round')
      ui.press('[')
      await ui.until(f => f.includes('~ openai/gpt-5-mini') && !f.includes('Project total'), 'back to OpenRouter')
      ui.press('[')
      await ui.until(f => f.includes('No limit data') && !f.includes('gpt-5-mini'), 'back to Codex')
      expect(fetched).toEqual(['p-anthropic', 'p-codex', 'p-router'])
    } finally {
      await ui.cleanup()
    }
  }, 30_000)

  it('a provider that reports no limits is never asked', async () => {
    setProfiles(PROFILES, 'p-router')
    fetcherSpy.mockImplementation(kind =>
      kind === 'openai'
        ? undefined
        : async profile => {
            fetched.push(profile.profileId ?? '?')
            return { rows: [] }
          },
    )
    try {
      const output = await renderUntil('global', 'OpenRouter · active')
      expect(output).toContain('Limits are not available for OpenRouter.')
      expect(output).toContain('No usage recorded in this project yet.')
      expect(fetched).toEqual([])
    } finally {
      fetcherSpy.mockImplementation(() => async profile => {
        fetched.push(profile.profileId ?? '?')
        return { rows: [] }
      })
    }
  })

  it('a failed read says why and offers the retry, which reads again', async () => {
    setProfiles(PROFILES, 'p-anthropic')
    let attempts = 0
    fetcherSpy.mockImplementation(() => async () => {
      attempts++
      if (attempts === 1) throw new Error('upstream down')
      return { rows: [{ kind: 'text', label: 'Recovered', value: 'yes' }] }
    })
    const ui = await mount('global')
    try {
      await ui.until(f => f.includes('Could not load limits: upstream down'), 'the error')
      expect(ui.frame()).toContain('r to retry')
      ui.press('r')
      await ui.until(f => f.includes('Recovered · yes'), 'the retried read')
      expect(attempts).toBe(2)
    } finally {
      fetcherSpy.mockImplementation(() => async profile => {
        fetched.push(profile.profileId ?? '?')
        return { rows: [] }
      })
      await ui.cleanup()
    }
  }, 30_000)

  it('r refreshes limits that loaded fine, too', async () => {
    setProfiles(PROFILES, 'p-anthropic')
    let attempts = 0
    fetcherSpy.mockImplementation(() => async () => {
      attempts++
      return { rows: [{ kind: 'text', label: 'Read', value: String(attempts) }] }
    })
    const ui = await mount('global')
    try {
      await ui.until(f => f.includes('Read · 1'), 'the first read')
      expect(ui.frame()).toContain('r refresh')
      ui.press('r')
      await ui.until(f => f.includes('Read · 2'), 'the refreshed read')
    } finally {
      fetcherSpy.mockImplementation(() => async profile => {
        fetched.push(profile.profileId ?? '?')
        return { rows: [] }
      })
      await ui.cleanup()
    }
  }, 30_000)
})
