/**
 * Characterization suite for `src/platform/bootstrap/state.ts`, written BEFORE
 * the barrel split and kept BYTE-IDENTICAL across every extraction commit.
 *
 * This module is 226 exports over ONE `STATE` object, so the split's whole risk
 * is concentrated in a single question: does `STATE` still live in exactly one
 * module afterwards? Two copies would typecheck, build and pass every existing
 * suite — 360 importers would just start reading a second, frozen session.
 *
 * So the tests below are deliberately CROSS-CLUSTER: each one writes through a
 * setter that is destined for one sibling module and reads back through a
 * getter destined for another. `resetStateForTests` is the sharpest of these —
 * it reaches every field in `STATE` plus three module-level `let`s that belong
 * to the cost cluster, so it is the one function that cannot work unless every
 * piece is wired to the same instance.
 *
 * `state.sessionSwitch.test.ts` already pins the signal-clear landmine and
 * `state.duration.test.ts` the active-time accounting; neither is duplicated
 * here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import * as stateModule from 'src/platform/bootstrap/state.js'
import {
  addInvokedSkill,
  addSessionCronTask,
  addToTotalCostState,
  addToTotalDurationState,
  addToToolDuration,
  clearBetaHeaderLatches,
  clearInvokedSkillsForAgent,
  clearPendingSessionWakeup,
  clearRegisteredHooks,
  clearSystemPromptSectionState,
  getAfkModeHeaderLatched,
  getBudgetContinuationCount,
  getClientType,
  getCurrentTurnTokenBudget,
  getCwdState,
  getInvokedSkills,
  getInvokedSkillsForAgent,
  getOriginalCwd,
  getPendingSessionWakeup,
  getProjectRoot,
  getRegisteredHooks,
  getSessionCronTasks,
  getSessionId,
  getSystemPromptSectionCache,
  getTotalAPIDuration,
  getTotalCostUSD,
  getTotalToolDuration,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
  isLspDeferLatched,
  latchLspDefer,
  onRuntimeStateChange,
  removeSessionCronTasks,
  resetStateForTests,
  setAfkModeHeaderLatched,
  setAllowedChannels,
  setClientType,
  setCwdState,
  setPendingSessionWakeup,
  setProjectRoot,
  setSystemPromptSectionCacheEntry,
  snapshotOutputTokensForTurn,
} from 'src/platform/bootstrap/state.js'

/**
 * `bun test` runs every file in one process, so a suite that leaves the cwd or
 * the session id pointing somewhere else owns that state for whatever sorts
 * after it. Snapshot the process-global fields, not just the cheap ones.
 */
let savedOriginalCwd = ''
let savedProjectRoot = ''
let savedCwdState = ''

beforeAll(() => {
  savedOriginalCwd = getOriginalCwd()
  savedProjectRoot = getProjectRoot()
  savedCwdState = getCwdState()
})

afterEach(() => {
  resetStateForTests()
})

afterAll(() => {
  resetStateForTests()
  stateModule.setOriginalCwd(savedOriginalCwd)
  setProjectRoot(savedProjectRoot)
  setCwdState(savedCwdState)
})

const USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 1,
  contextWindow: 200_000,
} as unknown as Parameters<typeof addToTotalCostState>[1]

// ───────────────────────────────────────────────────────────────────────────
// The barrel's surface. tsc catches a dropped export at the 360 call sites,
// but only for symbols something still imports — the count catches the rest,
// and the spot list names one symbol per future sibling module so a whole
// cluster cannot go missing quietly.
// ───────────────────────────────────────────────────────────────────────────

describe('the module export surface', () => {
  test('still exports 217 runtime symbols', () => {
    expect(Object.keys(stateModule)).toHaveLength(217)
  })

  test('exports at least one symbol from every planned cluster', () => {
    const names = new Set(Object.keys(stateModule))
    for (const name of [
      'onRuntimeStateChange', // store
      'getSessionId', // session
      'getCwdState', // cwd
      'getTotalCostUSD', // cost
      'getMeter', // telemetry
      'getIsNonInteractiveSession', // sessionFlags
      'getRegisteredHooks', // sdkHooks
      'getSessionCronTasks', // sessionArtifacts
      'isLspDeferLatched', // latches
      'resetStateForTests', // reset
    ]) {
      expect(names.has(name), `missing export: ${name}`).toBe(true)
    }
  })

  test('every exported symbol is defined', () => {
    for (const [name, value] of Object.entries(stateModule)) {
      expect(value, `${name} is undefined`).toBeDefined()
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The single-STATE proof. Write through eight clusters, reset from a ninth,
// read back through all eight. A duplicated STATE fails here and only here.
// ───────────────────────────────────────────────────────────────────────────

describe('STATE is one instance shared by every cluster', () => {
  test('resetStateForTests clears what every other cluster wrote', () => {
    setCwdState('/tmp/claudin-state-probe')
    setClientType('probe-client')
    addToTotalCostState(2.5, USAGE, 'probe-model')
    addToTotalDurationState(400, 300)
    addToToolDuration(70)
    addSessionCronTask({
      id: 'probe-cron',
      cron: '* * * * *',
      prompt: 'p',
      createdAt: 1,
    })
    setPendingSessionWakeup({ fireAtMs: 1, prompt: 'p', reason: 'r' })
    latchLspDefer('LSPTool')
    setAfkModeHeaderLatched(true)
    setSystemPromptSectionCacheEntry('probe-section', 'body')
    addInvokedSkill('probe-skill', '/skills/probe', 'body', 'agent-1')

    resetStateForTests()

    expect(getCwdState()).not.toBe('/tmp/claudin-state-probe')
    expect(getClientType()).not.toBe('probe-client')
    expect(getTotalCostUSD()).toBe(0)
    expect(getTotalAPIDuration()).toBe(0)
    expect(getTotalToolDuration()).toBe(0)
    expect(getSessionCronTasks()).toEqual([])
    expect(getPendingSessionWakeup()).toBeNull()
    expect(isLspDeferLatched('LSPTool')).toBe(false)
    expect(getAfkModeHeaderLatched()).toBeNull()
    expect(getSystemPromptSectionCache().size).toBe(0)
    expect(getInvokedSkills().size).toBe(0)
  })

  test('resetStateForTests also clears the three turn-token module vars', () => {
    // These three are plain module-level `let`s in the cost cluster, NOT fields
    // of STATE — so the reset has to reach across the module boundary to zero
    // them. Splitting cost out without a reset hook silently leaves a turn
    // budget latched for the rest of the process.
    snapshotOutputTokensForTurn(50_000)
    incrementBudgetContinuationCount()
    expect(getCurrentTurnTokenBudget()).toBe(50_000)
    expect(getBudgetContinuationCount()).toBe(1)

    resetStateForTests()

    expect(getCurrentTurnTokenBudget()).toBeNull()
    expect(getBudgetContinuationCount()).toBe(0)
    expect(getTurnOutputTokens()).toBe(0)
  })

  test('the runtime-state listener set is reached from another cluster', () => {
    // setAllowedChannels lives with the latches; onRuntimeStateChange lives
    // with the store. Duplicate the Set and this write notifies nobody.
    let notified = 0
    const unsubscribe = onRuntimeStateChange(() => {
      notified++
    })
    setAllowedChannels([])
    unsubscribe()
    expect(notified).toBe(1)
  })

  test('a session id is present and stable between reads', () => {
    const first = getSessionId()
    expect(first).toBe(getSessionId())
    expect(String(first).length).toBeGreaterThan(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Per-cluster behavior, so a failure localizes instead of only tripping the
// big cross-cluster test above.
// ───────────────────────────────────────────────────────────────────────────

describe('cost accumulation', () => {
  test('cost and duration accumulate rather than replace', () => {
    addToTotalCostState(1, USAGE, 'm')
    addToTotalCostState(0.5, USAGE, 'm')
    addToTotalDurationState(100, 80)
    addToTotalDurationState(50, 40)
    expect(getTotalCostUSD()).toBeCloseTo(1.5, 10)
    expect(getTotalAPIDuration()).toBe(150)
  })

  test('the turn budget snapshot replaces the previous one', () => {
    snapshotOutputTokensForTurn(1000)
    snapshotOutputTokensForTurn(2000)
    expect(getCurrentTurnTokenBudget()).toBe(2000)
  })
})

describe('cwd accessors', () => {
  test('the three paths are independent slots', () => {
    setCwdState('/tmp/a')
    setProjectRoot('/tmp/b')
    expect(getCwdState()).toBe('/tmp/a')
    expect(getProjectRoot()).toBe('/tmp/b')
  })
})

describe('session cron tasks', () => {
  test('removal reports how many it actually removed', () => {
    addSessionCronTask({ id: 'a', cron: '* * * * *', prompt: 'p', createdAt: 1 })
    addSessionCronTask({ id: 'b', cron: '* * * * *', prompt: 'p', createdAt: 2 })
    expect(removeSessionCronTasks(['a', 'missing'])).toBe(1)
    expect(getSessionCronTasks().map(t => t.id)).toEqual(['b'])
    expect(removeSessionCronTasks([])).toBe(0)
  })
})

describe('the single pending session wakeup', () => {
  test('setting reports whether it replaced one, and clearing empties it', () => {
    expect(setPendingSessionWakeup({ fireAtMs: 1, prompt: 'a', reason: 'r' })).toBe(false)
    expect(setPendingSessionWakeup({ fireAtMs: 2, prompt: 'b', reason: 'r' })).toBe(true)
    expect(getPendingSessionWakeup()?.prompt).toBe('b')
    clearPendingSessionWakeup()
    expect(getPendingSessionWakeup()).toBeNull()
  })
})

describe('invoked skills', () => {
  test('are keyed per agent and cleared per agent', () => {
    addInvokedSkill('s1', '/p1', 'c', 'agent-1')
    addInvokedSkill('s2', '/p2', 'c', 'agent-2')
    expect(getInvokedSkillsForAgent('agent-1').size).toBe(1)

    clearInvokedSkillsForAgent('agent-1')
    expect(getInvokedSkillsForAgent('agent-1').size).toBe(0)
    expect(getInvokedSkillsForAgent('agent-2').size).toBe(1)
  })
})

describe('beta header latches', () => {
  test('clearBetaHeaderLatches drops all of them at once', () => {
    setAfkModeHeaderLatched(true)
    latchLspDefer('LSPTool')
    expect(getAfkModeHeaderLatched()).toBe(true)
    expect(isLspDeferLatched('LSPTool')).toBe(true)

    clearBetaHeaderLatches()

    expect(getAfkModeHeaderLatched()).toBeNull()
    expect(isLspDeferLatched('LSPTool')).toBe(false)
  })
})

describe('the system prompt section cache', () => {
  test('is one Map, handed out by reference', () => {
    setSystemPromptSectionCacheEntry('a', 'body')
    expect(getSystemPromptSectionCache().get('a')).toBe('body')
    clearSystemPromptSectionState()
    expect(getSystemPromptSectionCache().size).toBe(0)
  })
})

describe('registered hooks', () => {
  test('repeated registration merges instead of overwriting', () => {
    stateModule.registerHookCallbacks({
      PreToolUse: [{ hooks: [] }] as never,
    })
    stateModule.registerHookCallbacks({
      PreToolUse: [{ hooks: [] }] as never,
    })
    expect(getRegisteredHooks()?.PreToolUse).toHaveLength(2)

    clearRegisteredHooks()
    expect(getRegisteredHooks()).toBeNull()
  })
})
