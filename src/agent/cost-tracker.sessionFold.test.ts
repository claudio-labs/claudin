/**
 * Characterization of the project-config side of the cost tracker: the
 * session-boundary fold of `last*` into `cumulative*`, the single-slot
 * restore, `/cost`'s text, the opt-in stderr token log and the advisor
 * recursion. Pinned before the per-provider usage change touches the fold.
 *
 * The project config is the in-memory test singleton that
 * getCurrentProjectConfig/saveCurrentProjectConfig use under NODE_ENV=test,
 * reset the same way cost-tracker.projectTotals.test.ts does.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  addToTotalLinesChanged,
  addToTotalSessionCost,
  formatTotalCost,
  getCostSinceRestoreUSD,
  getCostStateEntryFor,
  getModelUsage,
  getProjectTotals,
  getSourceUsage,
  getStoredSessionCosts,
  getTotalCost,
  resetCostState,
  resetCostStateOwnerForTesting,
  restoreCostStateForResume,
  restoreCostStateForSession,
  saveCostsAndStartNewSession,
  saveCurrentSessionCosts,
  setHasUnknownModelCost,
} from 'src/agent/cost-tracker.js'
import {
  addToTotalDurationState,
  getSessionId,
  markTurnEnd,
  markTurnStart,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/platform/config/config.js'
import type { ProjectConfig } from 'src/platform/config/config/types.js'
import { calculateUSDCost } from 'src/providers/usage/modelCost.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { CostStateModelUsage } from 'src/shared/types/logs.js'

type Usage = Parameters<typeof addToTotalSessionCost>[1]

const ANSI_RE = /\x1b\[[0-9;]*m/g
const NOW = 1_700_000_000_000
const MODEL = 'claude-opus-5-5'
const OTHER_MODEL = 'claude-haiku-5-5'

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
  webSearch = 0,
): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    ...(webSearch > 0
      ? { server_tool_use: { web_search_requests: webSearch } }
      : {}),
  } as Usage
}

function modelUsage(
  input: number,
  output: number,
  costUSD: number,
  extra: Partial<CostStateModelUsage> = {},
): CostStateModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD,
    ...extra,
  }
}

/** Every config key this file writes, so afterAll can put them all back. */
const COST_KEYS = [
  'cumulativeCost',
  'cumulativeAPIDuration',
  'cumulativeDuration',
  'cumulativeLinesAdded',
  'cumulativeLinesRemoved',
  'cumulativeModelUsage',
  'cumulativeProviderUsage',
  'lastCost',
  'lastAPIDuration',
  'lastAPIDurationWithoutRetries',
  'lastToolDuration',
  'lastDuration',
  'lastLinesAdded',
  'lastLinesRemoved',
  'lastTotalInputTokens',
  'lastTotalOutputTokens',
  'lastTotalCacheCreationInputTokens',
  'lastTotalCacheReadInputTokens',
  'lastTotalWebSearchRequests',
  'lastFpsAverage',
  'lastFpsLow1Pct',
  'lastModelUsage',
  'lastProviderUsage',
  'lastSessionId',
] as const satisfies ReadonlyArray<keyof ProjectConfig>

type CostSlice = Pick<ProjectConfig, (typeof COST_KEYS)[number]>

function pickCostSlice(config: ProjectConfig): CostSlice {
  return structuredClone(
    Object.fromEntries(COST_KEYS.map(k => [k, config[k]])),
  ) as CostSlice
}

function clearedSlice(): CostSlice {
  return Object.fromEntries(
    COST_KEYS.map(k => [k, undefined]),
  ) as CostSlice
}

function setConfig(patch: Partial<CostSlice>): void {
  saveCurrentProjectConfig(current => ({ ...current, ...patch }))
}

let savedSlice: CostSlice
let savedSessionId: string
let savedLogEnv: string | undefined
let nowSpy: ReturnType<typeof spyOn<DateConstructor, 'now'>>

beforeAll(() => {
  savedSlice = pickCostSlice(getCurrentProjectConfig())
  savedSessionId = getSessionId()
  savedLogEnv = process.env.CLAUDIN_LOG_TOKEN_USAGE
})

beforeEach(() => {
  delete process.env.CLAUDIN_LOG_TOKEN_USAGE
  // Frozen before resetCostState() captures the start time, so
  // getTotalDuration() is a deterministic Date.now() - start.
  nowSpy = spyOn(Date, 'now').mockReturnValue(NOW)
  switchSession(asSessionId('fold-current'), null)
  resetCostState()
  setConfig(clearedSlice())
})

afterEach(() => {
  nowSpy.mockRestore()
})

afterAll(() => {
  resetCostState()
  setConfig(savedSlice)
  switchSession(asSessionId(savedSessionId), null)
  if (savedLogEnv === undefined) delete process.env.CLAUDIN_LOG_TOKEN_USAGE
  else process.env.CLAUDIN_LOG_TOKEN_USAGE = savedLogEnv
})

describe('saveCurrentSessionCosts', () => {
  test('first save: last* holds the live counters, cumulative* stays zero', () => {
    addToTotalSessionCost(0.5, usage(10, 20, 30, 40, 2), MODEL)
    addToTotalLinesChanged(3, 1)
    addToTotalDurationState(1_200, 1_000)
    markTurnStart()
    nowSpy.mockReturnValue(NOW + 5_000)
    markTurnEnd()

    saveCurrentSessionCosts({ averageFps: 60, low1PctFps: 30 })

    const c = getCurrentProjectConfig()
    expect(c.lastSessionId).toBe('fold-current')
    expect(c.lastCost).toBeCloseTo(0.5)
    expect(c.lastAPIDuration).toBe(1_200)
    expect(c.lastAPIDurationWithoutRetries).toBe(1_000)
    expect(c.lastDuration).toBe(5_000)
    expect(c.lastLinesAdded).toBe(3)
    expect(c.lastLinesRemoved).toBe(1)
    expect(c.lastTotalInputTokens).toBe(10)
    expect(c.lastTotalOutputTokens).toBe(20)
    expect(c.lastTotalCacheReadInputTokens).toBe(30)
    expect(c.lastTotalCacheCreationInputTokens).toBe(40)
    expect(c.lastTotalWebSearchRequests).toBe(2)
    expect(c.lastFpsAverage).toBe(60)
    expect(c.lastFpsLow1Pct).toBe(30)
    expect(c.lastModelUsage).toEqual({
      [MODEL]: modelUsage(10, 20, 0.5, {
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
        webSearchRequests: 2,
      }),
    })
    expect(c.cumulativeCost).toBe(0)
    expect(c.cumulativeAPIDuration).toBe(0)
    expect(c.cumulativeDuration).toBe(0)
    expect(c.cumulativeLinesAdded).toBe(0)
    expect(c.cumulativeLinesRemoved).toBe(0)
    expect(c.cumulativeModelUsage).toEqual({})
  })

  test('same session: cumulative* is untouched and last* is overwritten', () => {
    setConfig({
      lastSessionId: 'fold-current',
      lastCost: 9,
      lastAPIDuration: 9_000,
      lastDuration: 9_000,
      lastLinesAdded: 9,
      lastLinesRemoved: 9,
      lastModelUsage: { [OTHER_MODEL]: modelUsage(900, 900, 9) },
      cumulativeCost: 1,
      cumulativeAPIDuration: 100,
      cumulativeDuration: 200,
      cumulativeLinesAdded: 3,
      cumulativeLinesRemoved: 4,
      cumulativeModelUsage: { [MODEL]: modelUsage(1, 2, 1) },
    })
    addToTotalSessionCost(0.25, usage(5, 6), MODEL)

    saveCurrentSessionCosts()

    const c = getCurrentProjectConfig()
    expect(c.cumulativeCost).toBe(1)
    expect(c.cumulativeAPIDuration).toBe(100)
    expect(c.cumulativeDuration).toBe(200)
    expect(c.cumulativeLinesAdded).toBe(3)
    expect(c.cumulativeLinesRemoved).toBe(4)
    expect(c.cumulativeModelUsage).toEqual({ [MODEL]: modelUsage(1, 2, 1) })
    expect(c.lastCost).toBeCloseTo(0.25)
    expect(c.lastLinesAdded).toBe(0)
    expect(c.lastModelUsage).toEqual({ [MODEL]: modelUsage(5, 6, 0.25) })
    expect(c.lastFpsAverage).toBeUndefined()
  })

  test('new session: the previous last* is folded into cumulative*, every field per model', () => {
    setConfig({
      lastSessionId: 'fold-previous',
      lastCost: 0.25,
      lastAPIDuration: 5_000,
      lastDuration: 6_000,
      lastLinesAdded: 3,
      lastLinesRemoved: 4,
      lastModelUsage: {
        [MODEL]: modelUsage(20, 10, 0.2, {
          cacheReadInputTokens: 7,
          cacheCreationInputTokens: 8,
          webSearchRequests: 1,
        }),
        [OTHER_MODEL]: modelUsage(3, 4, 0.05),
      },
      cumulativeCost: 0.5,
      cumulativeAPIDuration: 10_000,
      cumulativeDuration: 20_000,
      cumulativeLinesAdded: 1,
      cumulativeLinesRemoved: 2,
      cumulativeModelUsage: {
        [MODEL]: modelUsage(100, 50, 0.4, {
          cacheReadInputTokens: 70,
          cacheCreationInputTokens: 80,
          webSearchRequests: 10,
        }),
        'claude-sonnet-5': modelUsage(1, 1, 0.1),
      },
    })

    saveCurrentSessionCosts()

    const c = getCurrentProjectConfig()
    expect(c.cumulativeCost).toBeCloseTo(0.75)
    expect(c.cumulativeAPIDuration).toBe(15_000)
    expect(c.cumulativeDuration).toBe(26_000)
    expect(c.cumulativeLinesAdded).toBe(4)
    expect(c.cumulativeLinesRemoved).toBe(6)
    expect(c.cumulativeModelUsage?.[MODEL]).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      cacheReadInputTokens: 77,
      cacheCreationInputTokens: 88,
      webSearchRequests: 11,
      costUSD: expect.closeTo(0.6, 9),
    })
    // A model only in the closed session is copied; one only in the
    // cumulative totals is kept.
    expect(c.cumulativeModelUsage?.[OTHER_MODEL]).toEqual(modelUsage(3, 4, 0.05))
    expect(c.cumulativeModelUsage?.['claude-sonnet-5']).toEqual(
      modelUsage(1, 1, 0.1),
    )
    expect(c.lastSessionId).toBe('fold-current')
    expect(c.lastCost).toBe(0)
    expect(c.lastModelUsage).toEqual({})
  })

  test('the fold copies: later spend does not write into the cumulative entry', () => {
    const previous = modelUsage(3, 4, 0.05)
    setConfig({
      lastSessionId: 'fold-previous',
      lastModelUsage: { [OTHER_MODEL]: previous },
    })
    saveCurrentSessionCosts()
    const folded = getCurrentProjectConfig().cumulativeModelUsage?.[OTHER_MODEL]
    expect(folded).toEqual(modelUsage(3, 4, 0.05))
    expect(folded).not.toBe(getCurrentProjectConfig().lastModelUsage?.[OTHER_MODEL])
  })

  test('a second save in the same session does not fold twice', () => {
    setConfig({ lastSessionId: 'fold-previous', lastCost: 0.25, cumulativeCost: 0.5 })
    addToTotalSessionCost(0.1, usage(1, 1), MODEL)
    saveCurrentSessionCosts()
    saveCurrentSessionCosts()
    const c = getCurrentProjectConfig()
    expect(c.cumulativeCost).toBeCloseTo(0.75)
    expect(c.lastCost).toBeCloseTo(0.1)
  })
})

describe('getStoredSessionCosts', () => {
  test('undefined for a session other than the saved one', () => {
    setConfig({ lastSessionId: 'fold-previous', lastCost: 1 })
    expect(getStoredSessionCosts('fold-other')).toBeUndefined()
  })

  test('the slot for the saved session, with model limits attached', () => {
    setConfig({
      lastSessionId: 'fold-previous',
      lastCost: 1.5,
      lastAPIDuration: 100,
      lastAPIDurationWithoutRetries: 90,
      lastToolDuration: 30,
      lastLinesAdded: 7,
      lastLinesRemoved: 2,
      lastDuration: 4_000,
      lastModelUsage: { [MODEL]: modelUsage(10, 20, 1.5) },
    })
    const stored = getStoredSessionCosts('fold-previous')
    expect(stored).toMatchObject({
      totalCostUSD: 1.5,
      totalAPIDuration: 100,
      totalAPIDurationWithoutRetries: 90,
      totalToolDuration: 30,
      totalLinesAdded: 7,
      totalLinesRemoved: 2,
      lastDuration: 4_000,
    })
    const restored = stored?.modelUsage?.[MODEL]
    expect(restored).toMatchObject(modelUsage(10, 20, 1.5))
    expect(restored?.contextWindow).toBeGreaterThan(0)
    expect(restored?.maxOutputTokens).toBeGreaterThan(0)
  })

  test('missing fields read as zero and a missing model map as undefined', () => {
    setConfig({ lastSessionId: 'fold-previous' })
    expect(getStoredSessionCosts('fold-previous')).toEqual({
      totalCostUSD: 0,
      totalAPIDuration: 0,
      totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      lastDuration: undefined,
      modelUsage: undefined,
      providerUsage: {},
    })
  })
})

describe('restoreCostStateForSession', () => {
  test('false and nothing restored when the slot is another session', () => {
    setConfig({ lastSessionId: 'fold-previous', lastCost: 2 })
    expect(restoreCostStateForSession('fold-other')).toBe(false)
    expect(getTotalCost()).toBe(0)
  })

  test('true restores the slot, without sources and without claiming the counters', () => {
    setConfig({
      lastSessionId: 'fold-previous',
      lastCost: 2,
      lastModelUsage: { [MODEL]: modelUsage(10, 20, 2) },
    })
    addToTotalSessionCost(0.1, usage(1, 1), MODEL, 'repl_main_thread')
    expect(restoreCostStateForSession('fold-previous')).toBe(true)
    expect(getTotalCost()).toBe(2)
    expect(getModelUsage()[MODEL]?.inputTokens).toBe(10)
    expect(getSourceUsage()).toEqual({})
    expect(getCostStateEntryFor('fold-previous')).toBeUndefined()
  })

  test('as the project-config tier of a resume, it owns the counters and separates new spend', () => {
    setConfig({ lastSessionId: 'fold-previous', lastCost: 0.4 })
    const source = restoreCostStateForResume('fold-previous', { messages: [] })
    expect(source).toBe('project-config')
    expect(getCostStateEntryFor('fold-previous')?.totalCostUSD).toBeCloseTo(0.4)
    addToTotalSessionCost(0.1, usage(1, 1), MODEL)
    expect(getCostSinceRestoreUSD()).toBeCloseTo(0.1)
  })

  test('falls to the message replay when the slot is another session', () => {
    setConfig({ lastSessionId: 'fold-other', lastCost: 9 })
    const source = restoreCostStateForResume('fold-previous', {
      messages: [
        { type: 'assistant', message: { model: MODEL, usage: { input_tokens: 0, output_tokens: 0 } } },
      ],
    })
    expect(source).toBe('messages')
    // An all-zero usage is skipped, not billed as a zero-cost call.
    expect(getModelUsage()).toEqual({})
  })
})

describe('cost-state ownership', () => {
  test('resetCostStateOwnerForTesting lets the next stamp claim any session', () => {
    restoreCostStateForSession('fold-previous')
    expect(getCostStateEntryFor('fold-previous')).toBeUndefined()
    resetCostStateOwnerForTesting()
    expect(String(getCostStateEntryFor('fold-previous')?.sessionId)).toBe(
      'fold-previous',
    )
    expect(getCostStateEntryFor('fold-current')).toBeUndefined()
  })
})

describe('saveCostsAndStartNewSession', () => {
  test('saves under the old session, then switches, then zeroes the counters', () => {
    addToTotalSessionCost(0.3, usage(4, 5), MODEL)
    let seenInsideSwitch: {
      lastSessionId: string | undefined
      lastCost: number | undefined
      liveCost: number
    } | undefined

    saveCostsAndStartNewSession(() => {
      const c = getCurrentProjectConfig()
      seenInsideSwitch = {
        lastSessionId: c.lastSessionId,
        lastCost: c.lastCost,
        liveCost: getTotalCost(),
      }
      switchSession(asSessionId('fold-next'), null)
    })

    expect(seenInsideSwitch?.lastSessionId).toBe('fold-current')
    expect(seenInsideSwitch?.lastCost).toBeCloseTo(0.3)
    expect(seenInsideSwitch?.liveCost).toBeCloseTo(0.3)
    expect(getSessionId()).toBe(asSessionId('fold-next'))
    expect(getTotalCost()).toBe(0)
    expect(getModelUsage()).toEqual({})
    // The reset ran after the switch, so the fresh session owns the counters.
    expect(getCostStateEntryFor('fold-next')?.totalCostUSD).toBe(0)
    expect(getCostStateEntryFor('fold-current')).toBeUndefined()
  })
})

describe('getProjectTotals with live spend', () => {
  test('live per-model usage is merged into the cumulative totals', () => {
    setConfig({
      lastSessionId: 'fold-current',
      cumulativeCost: 1,
      cumulativeModelUsage: { [MODEL]: modelUsage(100, 10, 1) },
    })
    addToTotalSessionCost(0.5, usage(5, 6), MODEL)
    addToTotalSessionCost(0.2, usage(1, 2), OTHER_MODEL)
    const totals = getProjectTotals()
    expect(totals.totalCost).toBeCloseTo(1.7)
    expect(totals.modelUsage[MODEL]).toMatchObject({ inputTokens: 105, outputTokens: 16 })
    expect(totals.modelUsage[OTHER_MODEL]).toMatchObject({ inputTokens: 1, outputTokens: 2 })
  })
})

describe('formatTotalCost', () => {
  function plain(): string {
    return formatTotalCost().replace(ANSI_RE, '')
  }

  test('no usage: zero cost, plural zero lines, the empty usage line', () => {
    expect(plain()).toBe(
      'Total cost:            $0.0000\n' +
        'Total duration (API):  0s\n' +
        'Total duration (wall): 0s\n' +
        'Total code changes:    0 lines added, 0 lines removed\n' +
        'Usage:                 0 input, 0 output',
    )
  })

  test('one line is singular, and the unknown-model note follows the cost', () => {
    addToTotalLinesChanged(1, 1)
    setHasUnknownModelCost()
    const text = plain()
    expect(text).toContain('1 line added, 1 line removed')
    expect(text).toContain(
      'Total cost:            $0.0000 (costs may be inaccurate due to usage of unknown models)',
    )
  })

  test('two lines are plural', () => {
    addToTotalLinesChanged(2, 3)
    expect(plain()).toContain('2 lines added, 3 lines removed')
  })

  test('aggregates by canonical name and shows cache and web search only when > 0', () => {
    addToTotalSessionCost(0.75, usage(100, 200, 30, 0, 0), MODEL)
    addToTotalSessionCost(0.25, usage(50, 100, 0, 40, 2), 'anthropic/claude-opus-5.5')
    addToTotalSessionCost(0.01, usage(7, 8), OTHER_MODEL)
    const lines = plain().split('\n')
    const header = lines.indexOf('Usage by model:')
    expect(header).toBeGreaterThan(-1)
    expect(lines.slice(header + 1)).toEqual([
      '     claude-opus-5-5:  150 input, 300 output, 30 cache read, 40 cache write, 2 web search ($1.00)',
      '    claude-haiku-5-5:  7 input, 8 output ($0.0100)',
    ])
    expect(lines[0]).toBe('Total cost:            $1.01')
  })

  test('large token counts use the compact number format', () => {
    addToTotalSessionCost(0.1, usage(1_500, 2), MODEL)
    expect(plain()).toContain('1.5k input, 2 output')
  })
})

describe('CLAUDIN_LOG_TOKEN_USAGE', () => {
  function stderrLines(value: string): string[] {
    process.env.CLAUDIN_LOG_TOKEN_USAGE = value
    const writes: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      },
    )
    try {
      addToTotalSessionCost(0.02, usage(11, 12, 13, 14), MODEL)
    } finally {
      spy.mockRestore()
    }
    return writes.filter(w => w.includes('claudin.tokenUsage'))
  }

  for (const off of ['', '0', 'false', 'off', ' OFF ']) {
    test(`'${off}' writes nothing`, () => {
      expect(stderrLines(off)).toEqual([])
    })
  }

  for (const on of ['1', 'verbose', ' TRUE ']) {
    test(`'${on}' writes one JSON line per request`, () => {
      const lines = stderrLines(on)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.endsWith('\n')).toBe(true)
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        tag: 'claudin.tokenUsage',
        model: MODEL,
        input_tokens: 11,
        output_tokens: 12,
        cache_read_input_tokens: 13,
        cache_creation_input_tokens: 14,
        cost_usd: 0.02,
      })
    })
  }
})

describe('advisor usage', () => {
  test('each advisor iteration is billed under its own model and added to the total', () => {
    const advisor = {
      type: 'advisor_message',
      model: OTHER_MODEL,
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const main = {
      ...usage(10, 20),
      iterations: [
        { type: 'message', input_tokens: 10, output_tokens: 20 },
        advisor,
      ],
    } as unknown as Usage
    const advisorCost = calculateUSDCost(
      OTHER_MODEL,
      advisor as unknown as Usage,
    )
    expect(advisorCost).toBeGreaterThan(0)

    const total = addToTotalSessionCost(0.5, main, MODEL, 'repl_main_thread')

    expect(total).toBeCloseTo(0.5 + advisorCost, 9)
    expect(getTotalCost()).toBeCloseTo(0.5 + advisorCost, 9)
    expect(getModelUsage()[OTHER_MODEL]).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 500,
    })
    expect(getModelUsage()[MODEL]?.inputTokens).toBe(10)
    // The advisor spend inherits the request's source.
    expect(getSourceUsage().repl_main_thread?.calls).toBe(2)
  })

  test('usage without iterations bills only the request itself', () => {
    expect(addToTotalSessionCost(0.5, usage(1, 1), MODEL)).toBe(0.5)
    expect(Object.keys(getModelUsage())).toEqual([MODEL])
  })
})
