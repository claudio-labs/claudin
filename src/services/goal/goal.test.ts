import { describe, expect, test } from 'bun:test'
import { getSessionId } from 'src/bootstrap/state.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { Message } from 'src/types/message.js'
import { executeSessionEndHooks } from 'src/services/lifecycleHooks/events.js'
import { createAssistantMessage } from 'src/services/messages/factories.js'
import {
  addFunctionHook,
  addSessionHook,
  removeGoalStopHooks,
  type SessionStore,
} from 'src/services/lifecycleHooks/sessionHooks.js'
import { isStopConditionJudge } from 'src/services/lifecycleHooks/stopConditionJudge.js'
import type { AggregatedHookResult } from 'src/services/lifecycleHooks/types.js'
import {
  buildGoalDirective,
  buildGoalHook,
  clearActiveGoal,
  extractGoalReason,
  GOAL_ITERATION_CAP_INTERACTIVE,
  GOAL_ITERATION_CAP_NON_INTERACTIVE,
  GOAL_JUDGE_TIMEOUT_SECONDS,
  GOAL_MAX_CONDITION_LENGTH,
  getGoalIterationCap,
  getGoalTokenCount,
  handleGoalBlockingError,
  resetGoalStateForSessionEnd,
  setActiveGoal,
  shouldWarnGoalCheckIncomplete,
} from 'src/services/goal/goal.js'

const SESSION_ID = 'test-session'

type TestHarness = {
  getState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}

function createHarness(): TestHarness {
  // Minimal AppState slice used by the goal helpers. The cast is confined to
  // the test harness; the helpers only touch sessionHooks/activeGoal/
  // lastGoalResult.
  let state = {
    sessionHooks: new Map<string, SessionStore>(),
    activeGoal: undefined,
    lastGoalResult: undefined,
  } as unknown as AppState
  return {
    getState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

type StopMatchers = NonNullable<SessionStore['hooks']['Stop']>

function getStopMatchers(
  harness: TestHarness,
  sessionId: string = SESSION_ID,
): StopMatchers {
  const store = harness.getState().sessionHooks.get(sessionId) as
    | SessionStore
    | undefined
  return store?.hooks['Stop'] ?? []
}

function getRegisteredGoalEntries(harness: TestHarness) {
  return getRegisteredGoalEntriesFor(harness, SESSION_ID)
}

function getRegisteredGoalEntriesFor(harness: TestHarness, sessionId: string) {
  return getStopMatchers(harness, sessionId)
    .flatMap(m => m.hooks)
    .filter(h => isStopConditionJudge(h.hook))
}

function goalBlockingError(condition: string, reason: string) {
  return {
    blockingError: `[${condition}]: ${reason}`,
    command: condition,
  }
}

describe('getGoalTokenCount', () => {
  // createAssistantMessage pins model to SYNTHETIC_MODEL, which getTokenUsage
  // skips. Give it a real model + usage so getCurrentUsage counts it.
  function messageWithUsage(usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }): Message {
    const base = createAssistantMessage({ content: 'done' })
    return {
      ...base,
      message: {
        ...base.message,
        model: 'claude-opus-4-8',
        usage: { ...base.message.usage, ...usage },
      },
    }
  }

  test('sums the latest API response usage (matches the ctx pill)', () => {
    const msg = messageWithUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 1000,
    })
    expect(getGoalTokenCount([msg])).toBe(1125)
  })

  test('reads the most recent usage-bearing message, not the cumulative sum', () => {
    const older = messageWithUsage({
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    const newer = messageWithUsage({
      input_tokens: 200,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 500,
    })
    expect(getGoalTokenCount([older, newer])).toBe(730)
  })

  test('returns 0 when no message carries usage', () => {
    expect(getGoalTokenCount([])).toBe(0)
  })
})

describe('setActiveGoal', () => {
  test('registers a marked judge Stop session hook and activeGoal state', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    const entries = getRegisteredGoalEntries(harness)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.hook).toMatchObject({
      type: 'prompt',
      prompt: 'tests pass',
      timeout: GOAL_JUDGE_TIMEOUT_SECONDS,
    })
    expect(entries[0]!.onHookSuccess).toBeDefined()

    const goal = harness.getState().activeGoal
    expect(goal).toBeDefined()
    expect(goal!.condition).toBe('tests pass')
    expect(goal!.iterations).toBe(0)
    expect(goal!.setAt).toBeGreaterThan(0)
  })

  test('replacing a goal removes the previous judge hook (only one judge)', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'first condition')
    setActiveGoal(harness.setAppState, SESSION_ID, 'second condition')

    const entries = getRegisteredGoalEntries(harness)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.hook).toMatchObject({
      type: 'prompt',
      prompt: 'second condition',
    })
    expect(harness.getState().activeGoal?.condition).toBe('second condition')
  })

  test('replacing a goal preserves function hooks under the same matcher', () => {
    const harness = createHarness()
    addFunctionHook(
      harness.setAppState,
      SESSION_ID,
      'Stop',
      '',
      () => true,
      'function hook error',
    )
    setActiveGoal(harness.setAppState, SESSION_ID, 'a condition')
    setActiveGoal(harness.setAppState, SESSION_ID, 'another condition')

    const allHooks = getStopMatchers(harness).flatMap(m => m.hooks)
    const functionHooks = allHooks.filter(h => h.hook.type === 'function')
    const promptHooks = allHooks.filter(h => h.hook.type === 'prompt')
    expect(functionHooks).toHaveLength(1)
    expect(promptHooks).toHaveLength(1)
  })

  test('replacing a goal preserves non-judge prompt Stop hooks (user/frontmatter)', () => {
    const harness = createHarness()
    // Simulate a user-defined bare prompt Stop session hook — same shape as
    // a goal judge but without the marker.
    addSessionHook(harness.setAppState, SESSION_ID, 'Stop', '', {
      type: 'prompt',
      prompt: 'user-defined condition',
    })
    setActiveGoal(harness.setAppState, SESSION_ID, 'a condition')
    setActiveGoal(harness.setAppState, SESSION_ID, 'another condition')

    const allPromptHooks = getStopMatchers(harness)
      .flatMap(m => m.hooks)
      .filter(h => h.hook.type === 'prompt')
    expect(allPromptHooks).toHaveLength(2)
    const userHooks = allPromptHooks.filter(h => !isStopConditionJudge(h.hook))
    expect(userHooks).toHaveLength(1)
    expect(userHooks[0]!.hook).toMatchObject({
      prompt: 'user-defined condition',
    })
  })
})

describe('goal judge success callback (auto-clear)', () => {
  function triggerSuccess(harness: TestHarness, result: AggregatedHookResult) {
    const entries = getRegisteredGoalEntries(harness)
    expect(entries).toHaveLength(1)
    entries[0]!.onHookSuccess!(entries[0]!.hook, result)
  }

  test('ok:true clears the hook and activeGoal, records achieved result', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')
    triggerSuccess(harness, { stopReason: 'all 12 tests passed' })

    expect(getRegisteredGoalEntries(harness)).toHaveLength(0)
    expect(harness.getState().activeGoal).toBeUndefined()
    const result = harness.getState().lastGoalResult
    expect(result).toBeDefined()
    expect(result!.condition).toBe('tests pass')
    expect(result!.reason).toBe('all 12 tests passed')
    expect(result!.impossible).toBe(false)
  })

  test('impossible verdict clears the goal and records impossible:true', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'divide by zero')
    triggerSuccess(harness, {
      stopReason: 'mathematically impossible',
      impossible: true,
    })

    expect(harness.getState().activeGoal).toBeUndefined()
    expect(harness.getState().lastGoalResult?.impossible).toBe(true)
    expect(harness.getState().lastGoalResult?.reason).toBe(
      'mathematically impossible',
    )
  })

  test('stale callback (goal replaced) does not clear the new goal', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'old condition')
    const oldEntries = getRegisteredGoalEntries(harness)
    const oldEntry = oldEntries[0]!

    setActiveGoal(harness.setAppState, SESSION_ID, 'new condition')
    // The old judge's success callback fires late
    oldEntry.onHookSuccess!(oldEntry.hook, { stopReason: 'stale' })

    expect(harness.getState().activeGoal?.condition).toBe('new condition')
    expect(getRegisteredGoalEntries(harness)).toHaveLength(1)
    expect(harness.getState().lastGoalResult).toBeUndefined()
  })
})

describe('clearActiveGoal', () => {
  test('removes the session hook and clears state', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    const cleared = clearActiveGoal(harness.setAppState, SESSION_ID)
    expect(cleared).toBe(true)
    expect(getRegisteredGoalEntries(harness)).toHaveLength(0)
    expect(harness.getState().activeGoal).toBeUndefined()
  })

  test('returns false when nothing to clear', () => {
    const harness = createHarness()
    expect(clearActiveGoal(harness.setAppState, SESSION_ID)).toBe(false)
  })
})

describe('session-end goal reset (/clear and in-process /resume)', () => {
  test('executeSessionEndHooks clears activeGoal, lastGoalResult, and the judge hook', async () => {
    const harness = createHarness()
    // executeSessionEndHooks clears hooks under the process-global session id
    // (getSessionId()), so register the goal there — exactly what /goal does.
    const sessionId = getSessionId()
    setActiveGoal(harness.setAppState, sessionId, 'tests pass')
    harness.setAppState(prev => ({
      ...prev,
      lastGoalResult: {
        condition: 'old goal',
        impossible: false,
        at: Date.now(),
      },
    }))

    // Skip actual hook execution (no user hooks must run in tests); the
    // cleanup block under test runs regardless.
    const prevSimple = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    try {
      await executeSessionEndHooks('clear', {
        getAppState: harness.getState,
        setAppState: harness.setAppState,
      })
    } finally {
      if (prevSimple === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = prevSimple
      }
    }

    // Regression (/clear, in-process /resume): both the judge hook AND the
    // goal app state are gone — no orphaned "Goal active" footer.
    expect(harness.getState().activeGoal).toBeUndefined()
    expect(harness.getState().lastGoalResult).toBeUndefined()
    expect(harness.getState().sessionHooks.get(sessionId)).toBeUndefined()

    // Regression (M3): in the fresh session, no goal is active at turn start,
    // so the "Goal check did not complete" warning can never fire.
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: harness.getState().activeGoal,
        goalAfter: harness.getState().activeGoal,
        goalJudgeBlocked: false,
        aborted: false,
      }),
    ).toBe(false)

    // Setting a new goal right after the reset works (registry re-add).
    setActiveGoal(harness.setAppState, sessionId, 'new goal')
    expect(harness.getState().activeGoal?.condition).toBe('new goal')
    expect(getRegisteredGoalEntriesFor(harness, sessionId)).toHaveLength(1)
  })

  test('resetGoalStateForSessionEnd clears state but leaves the hooks registry alone', () => {
    // Order-independence with clearSessionHooks: the state reset must not
    // read or mutate sessionHooks (and vice versa).
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    resetGoalStateForSessionEnd(harness.setAppState)
    expect(harness.getState().activeGoal).toBeUndefined()
    expect(harness.getState().lastGoalResult).toBeUndefined()
    expect(getRegisteredGoalEntries(harness)).toHaveLength(1)
  })

  test('resetGoalStateForSessionEnd is an identity no-op when already clean', () => {
    const harness = createHarness()
    const before = harness.getState()
    resetGoalStateForSessionEnd(harness.setAppState)
    expect(harness.getState()).toBe(before)
  })
})

describe('shouldWarnGoalCheckIncomplete (M3 warning gate)', () => {
  const goal = { condition: 'tests pass' }

  test('warns when the goal is still active and the judge was silent', () => {
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: goal,
        goalAfter: goal,
        goalJudgeBlocked: false,
        aborted: false,
      }),
    ).toBe(true)
  })

  test('never warns when no goal was active at turn start (fresh session)', () => {
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: undefined,
        goalAfter: undefined,
        goalJudgeBlocked: false,
        aborted: false,
      }),
    ).toBe(false)
  })

  test('no warning when the judge blocked the stop this turn', () => {
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: goal,
        goalAfter: goal,
        goalJudgeBlocked: true,
        aborted: false,
      }),
    ).toBe(false)
  })

  test('no warning when the goal transitioned (cleared or replaced)', () => {
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: goal,
        goalAfter: undefined,
        goalJudgeBlocked: false,
        aborted: false,
      }),
    ).toBe(false)
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: goal,
        goalAfter: { condition: 'another goal' },
        goalJudgeBlocked: false,
        aborted: false,
      }),
    ).toBe(false)
  })

  test('no warning on a deliberate interrupt (ESC cancels the judge)', () => {
    expect(
      shouldWarnGoalCheckIncomplete({
        goalBefore: goal,
        goalAfter: goal,
        goalJudgeBlocked: false,
        aborted: true,
      }),
    ).toBe(false)
  })
})

describe('removeGoalStopHooks', () => {
  test('removes only marked judge hooks, never other prompt Stop hooks', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'a goal')
    // Simulate a skill-scoped prompt Stop hook and a bare user prompt hook —
    // neither carries the judge marker, so both must survive.
    harness.setAppState(prev => {
      const store = prev.sessionHooks.get(SESSION_ID)!
      store.hooks['Stop'] = [
        ...(store.hooks['Stop'] ?? []),
        {
          matcher: '',
          skillRoot: '/some/skill',
          hooks: [{ hook: { type: 'prompt', prompt: 'skill condition' } }],
        },
        {
          matcher: '',
          hooks: [{ hook: { type: 'prompt', prompt: 'user condition' } }],
        },
      ]
      return prev
    })

    const removed = removeGoalStopHooks(harness.setAppState, SESSION_ID)
    expect(removed).toBe(1) // only the marked goal judge
    const remaining = getStopMatchers(harness).flatMap(m => m.hooks)
    expect(remaining).toHaveLength(2)
    expect(remaining.map(h => (h.hook as { prompt: string }).prompt)).toEqual([
      'skill condition',
      'user condition',
    ])
  })

  test('returns 0 when no judge hooks are registered', () => {
    const harness = createHarness()
    addSessionHook(harness.setAppState, SESSION_ID, 'Stop', '', {
      type: 'prompt',
      prompt: 'user condition',
    })
    expect(removeGoalStopHooks(harness.setAppState, SESSION_ID)).toBe(0)
    expect(getStopMatchers(harness).flatMap(m => m.hooks)).toHaveLength(1)
  })
})

describe('stop-pipeline iteration counting', () => {
  test('handleGoalBlockingError increments iterations and records last check', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    const outcome = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      goalBlockingError('tests pass', '3 tests still failing'),
      false,
    )
    expect(outcome).toEqual({ kind: 'counted', iterations: 1 })
    expect(harness.getState().activeGoal?.iterations).toBe(1)
    expect(harness.getState().activeGoal?.lastCheckReason).toBe(
      '3 tests still failing',
    )

    const outcome2 = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      goalBlockingError('tests pass', '1 test still failing'),
      false,
    )
    expect(outcome2).toEqual({ kind: 'counted', iterations: 2 })
    expect(harness.getState().activeGoal?.iterations).toBe(2)
    expect(harness.getState().activeGoal?.lastCheckReason).toBe(
      '1 test still failing',
    )
  })

  test('blocking errors from other hooks are not counted', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    const outcome = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      {
        blockingError: '[./lint.sh]: lint failed',
        command: './lint.sh',
      },
      false,
    )
    expect(outcome).toEqual({ kind: 'not-goal' })
    expect(harness.getState().activeGoal?.iterations).toBe(0)
  })

  test('reaching the interactive cap clears the goal and reports cap-reached', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')
    // Pre-load the counter just below the cap
    harness.setAppState(prev => ({
      ...prev,
      activeGoal: {
        ...prev.activeGoal!,
        iterations: GOAL_ITERATION_CAP_INTERACTIVE - 1,
      },
    }))

    const outcome = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      goalBlockingError('tests pass', 'still failing'),
      false,
    )
    expect(outcome).toEqual({
      kind: 'cap-reached',
      cap: GOAL_ITERATION_CAP_INTERACTIVE,
      reason: 'still failing',
    })
    // Goal cleared: state gone and judge hook removed
    expect(harness.getState().activeGoal).toBeUndefined()
    expect(getRegisteredGoalEntries(harness)).toHaveLength(0)
  })

  test('non-interactive sessions cap at the lower headless limit', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')
    harness.setAppState(prev => ({
      ...prev,
      activeGoal: {
        ...prev.activeGoal!,
        iterations: GOAL_ITERATION_CAP_NON_INTERACTIVE - 1,
      },
    }))

    const outcome = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      goalBlockingError('tests pass', 'still failing'),
      true,
    )
    expect(outcome).toEqual({
      kind: 'cap-reached',
      cap: GOAL_ITERATION_CAP_NON_INTERACTIVE,
      reason: 'still failing',
    })
    expect(harness.getState().activeGoal).toBeUndefined()
  })

  test('below the cap the goal survives in non-interactive sessions', () => {
    const harness = createHarness()
    setActiveGoal(harness.setAppState, SESSION_ID, 'tests pass')

    const outcome = handleGoalBlockingError(
      harness.setAppState,
      SESSION_ID,
      'tests pass',
      goalBlockingError('tests pass', 'still failing'),
      true,
    )
    expect(outcome).toEqual({ kind: 'counted', iterations: 1 })
    expect(harness.getState().activeGoal?.condition).toBe('tests pass')
  })
})

describe('helpers', () => {
  test('extractGoalReason strips the [condition]: prefix', () => {
    expect(extractGoalReason('[do x]: not done yet', 'do x')).toBe(
      'not done yet',
    )
    expect(extractGoalReason('unrelated text', 'do x')).toBeUndefined()
  })

  test('buildGoalHook builds a marked judge prompt hook with a 120s timeout', () => {
    const hook = buildGoalHook('c')
    expect(hook).toMatchObject({
      type: 'prompt',
      prompt: 'c',
      timeout: GOAL_JUDGE_TIMEOUT_SECONDS,
    })
    expect(GOAL_JUDGE_TIMEOUT_SECONDS).toBe(120)
    expect(isStopConditionJudge(hook)).toBe(true)
    // The marker is symbol-keyed: it never serializes, so it can never be
    // forged from settings.json / frontmatter (JSON has no symbol keys).
    expect(JSON.parse(JSON.stringify(hook))).toEqual({
      type: 'prompt',
      prompt: 'c',
      timeout: GOAL_JUDGE_TIMEOUT_SECONDS,
    })
    expect(isStopConditionJudge(JSON.parse(JSON.stringify(hook)))).toBe(false)
  })

  test('getGoalIterationCap picks the cap by session interactivity', () => {
    expect(getGoalIterationCap(false)).toBe(GOAL_ITERATION_CAP_INTERACTIVE)
    expect(getGoalIterationCap(true)).toBe(GOAL_ITERATION_CAP_NON_INTERACTIVE)
    expect(GOAL_ITERATION_CAP_INTERACTIVE).toBe(50)
    expect(GOAL_ITERATION_CAP_NON_INTERACTIVE).toBe(10)
  })

  test('buildGoalDirective embeds the condition and the /goal clear caveat', () => {
    const directive = buildGoalDirective('tests pass')
    expect(directive).toContain(
      'A session-scoped Stop hook is now active with condition: "tests pass".',
    )
    expect(directive).toContain('do not tell the user to run `/goal clear`')
  })

  test('GOAL_MAX_CONDITION_LENGTH matches upstream limit', () => {
    expect(GOAL_MAX_CONDITION_LENGTH).toBe(4000)
  })
})
