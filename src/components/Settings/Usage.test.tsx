import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { renderToString } from 'src/components/staticRender.js'
import { recordBytesSaved, resetBytesSaved } from 'src/services/context/tokensSaved.js'

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

let totalCost = 0
let totalAPIDuration = 0
let totalDuration = 0
let totalLinesAdded = 0
let totalLinesRemoved = 0
let modelUsage: Record<string, ModelUsageRecord> = {}
let unknownCost = false
let projectTotals: {
  totalCost: number
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  modelUsage: Record<string, Omit<ModelUsageRecord, 'contextWindow' | 'maxOutputTokens'>>
} = {
  totalCost: 0,
  totalAPIDuration: 0,
  totalDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  modelUsage: {},
}

const realCostTracker = { ...(await import('src/cost-tracker.js')) }

mock.module('src/cost-tracker.js', () => ({
  ...realCostTracker,
  getTotalCost: () => totalCost,
  getTotalAPIDuration: () => totalAPIDuration,
  getTotalDuration: () => totalDuration,
  getTotalLinesAdded: () => totalLinesAdded,
  getTotalLinesRemoved: () => totalLinesRemoved,
  getModelUsage: () => modelUsage,
  hasUnknownModelCost: () => unknownCost,
  getProjectTotals: () => projectTotals,
}))

function resetState() {
  totalCost = 0
  totalAPIDuration = 0
  totalDuration = 0
  totalLinesAdded = 0
  totalLinesRemoved = 0
  modelUsage = {}
  unknownCost = false
  resetBytesSaved()
  projectTotals = {
    totalCost: 0,
    totalAPIDuration: 0,
    totalDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    modelUsage: {},
  }
}

function makeUsage(partial: Partial<ModelUsageRecord>): ModelUsageRecord {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    ...partial,
  }
}

describe('<SessionCostStats />', () => {
  beforeEach(resetState)
  afterEach(resetState)

  it('renders nothing when there is no usage in the session', async () => {
    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats />, 100))
    expect(output.trim()).toBe('')
  })

  it('renders cost, durations, and per-model usage for a single model without cache', async () => {
    totalCost = 0.0008
    totalAPIDuration = 6000
    totalDuration = 156000
    totalLinesAdded = 0
    totalLinesRemoved = 0
    modelUsage = {
      'claude-haiku-4-5-20251001': makeUsage({
        inputTokens: 680,
        outputTokens: 25,
        costUSD: 0.0008,
      }),
    }
    projectTotals = {
      totalCost: 0.0008,
      totalAPIDuration: 6000,
      totalDuration: 156000,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 680, outputTokens: 25, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0008 } },
    }

    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats />, 120))

    expect(output).toContain('Project total (all sessions)')
    expect(output).toContain('Total cost:')
    expect(output).toContain('$0.0008')
    expect(output).toContain('Total duration (API):  6s')
    expect(output).toContain('Total duration (wall): 2m 36s')
    expect(output).toContain('Total code changes:    0 lines added, 0 lines removed')
    expect(output).toContain('Usage by model:')
    expect(output).toContain('680 input, 25 output')
    expect(output).not.toContain('cache read')
    expect(output).not.toContain('cache write')
    expect(output).not.toContain('web search')
  })

  it('renders the cumulative project total values', async () => {
    totalCost = 0.05
    modelUsage = {
      'claude-opus-4-7-20251101': makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.05 }),
    }
    projectTotals = {
      totalCost: 1.23,
      totalAPIDuration: 60000,
      totalDuration: 600000,
      totalLinesAdded: 42,
      totalLinesRemoved: 7,
      modelUsage: { 'claude-opus-4-7-20251101': { inputTokens: 5000, outputTokens: 2500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.23 } },
    }

    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats />, 140))

    expect(output).toContain('Project total (all sessions)')
    expect(output).toContain('$1.23')
    expect(output).toContain('42 lines added, 7 lines removed')
    expect(output).toContain('5.0k input, 2.5k output')
  })

  it('includes cache and web search lines when those counts are non-zero', async () => {
    totalCost = 0.103
    totalAPIDuration = 6000
    totalDuration = 156000
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
    projectTotals = {
      totalCost: 0.103,
      totalAPIDuration: 6000,
      totalDuration: 156000,
      totalLinesAdded: 1,
      totalLinesRemoved: 2,
      modelUsage: { 'claude-opus-4-7-20251101': { inputTokens: 6, outputTokens: 25, cacheReadInputTokens: 15900, cacheCreationInputTokens: 15100, webSearchRequests: 3, costUSD: 0.103 } },
    }

    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats />, 140))

    expect(output).toContain('Total code changes:    1 line added, 2 lines removed')
    expect(output).toContain('cache read')
    expect(output).toContain('cache write')
    expect(output).toContain('web search')
    expect(output).toContain('$0.10')
  })

  it('session view shows the Context tokens saved line when bytes were saved', async () => {
    totalCost = 0.01
    modelUsage = {
      'claude-opus-4-7-20251101': makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.01 }),
    }
    recordBytesSaved(4_000_000, 0) // 4 MB → ~1m tokens

    const { Usage } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<Usage view="session" />, 140))

    expect(output).toContain('Current session')
    expect(output).toContain('Context tokens saved:')
    expect(output).toContain('tokens')
  })

  it('session view hides the line when nothing was saved', async () => {
    totalCost = 0.01
    modelUsage = {
      'claude-opus-4-7-20251101': makeUsage({ inputTokens: 100, outputTokens: 50, costUSD: 0.01 }),
    }
    // no recordBytesSaved → 0

    const { Usage } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<Usage view="session" />, 140))

    expect(output).toContain('Current session')
    expect(output).not.toContain('Context tokens saved')
  })

  it('global/project view never shows the line even when bytes were saved', async () => {
    projectTotals = {
      totalCost: 1.0,
      totalAPIDuration: 6000,
      totalDuration: 156000,
      totalLinesAdded: 1,
      totalLinesRemoved: 0,
      modelUsage: { 'claude-opus-4-7-20251101': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.0 } },
    }
    recordBytesSaved(4_000_000, 0)

    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats view="global" />, 140))

    expect(output).toContain('Project total (all sessions)')
    expect(output).not.toContain('Context tokens saved')
  })

  it('appends the unknown-cost warning when hasUnknownModelCost is true', async () => {
    totalCost = 0
    modelUsage = {
      'mystery-model': makeUsage({ inputTokens: 10, outputTokens: 5 }),
    }
    projectTotals = {
      totalCost: 0,
      totalAPIDuration: 0,
      totalDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      modelUsage: { 'mystery-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
    }
    unknownCost = true

    const { SessionCostStats } = await import('./Usage.js')
    const output = stripAnsi(await renderToString(<SessionCostStats />, 160))

    expect(output).toContain('costs may be inaccurate due to usage of unknown models')
  })
})
