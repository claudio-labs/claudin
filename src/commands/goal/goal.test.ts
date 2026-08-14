import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { AppState } from 'src/state/AppStateStore.js'
import type { ToolUseContext } from 'src/Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/types/command.js'
import { GOAL_MAX_CONDITION_LENGTH } from 'src/services/goal/goal.js'
import type { SessionStore } from 'src/services/lifecycleHooks/sessionHooks.js'

// The /goal set path consults process-global gates (hook policy snapshot +
// workspace trust). In a full-suite run, earlier test files can leave those
// globals flipped (bun state is process-wide), which would make the set case
// bail with a policy message. Pin the gates to their permissive defaults so
// this file is deterministic regardless of run order.
const realHooksConfigSnapshot = await import(
  'src/services/lifecycleHooks/hooksConfigSnapshot.js'
)
mock.module('src/services/lifecycleHooks/hooksConfigSnapshot.js', () => ({
  ...realHooksConfigSnapshot,
  shouldDisableAllHooksIncludingManaged: () => false,
  shouldAllowManagedHooksOnly: () => false,
}))
const realHooksShared = await import('src/services/lifecycleHooks/shared.js')
mock.module('src/services/lifecycleHooks/shared.js', () => ({
  ...realHooksShared,
  shouldSkipHookDueToTrust: () => false,
}))

const { call, parseGoalArgs } = await import('./goal.js')

// Re-pin the mocked modules to their captured real namespaces. Bun's
// `mock.module` is process-global and `mock.restore()` does not undo it, so
// without this every later test file would inherit this file's stubs.
afterAll(() => {
  mock.module(
    'src/services/lifecycleHooks/hooksConfigSnapshot.js',
    () => realHooksConfigSnapshot,
  )
  mock.module('src/services/lifecycleHooks/shared.js', () => realHooksShared)
})

describe('parseGoalArgs', () => {
  test('empty args → status', () => {
    expect(parseGoalArgs('')).toEqual({ kind: 'status' })
    expect(parseGoalArgs('   ')).toEqual({ kind: 'status' })
  })

  test('clear keyword → clear', () => {
    expect(parseGoalArgs('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalArgs('  clear  ')).toEqual({ kind: 'clear' })
  })

  test('condition → set (trimmed)', () => {
    expect(parseGoalArgs('  all tests pass  ')).toEqual({
      kind: 'set',
      condition: 'all tests pass',
    })
  })

  test('a condition mentioning clear is still a set', () => {
    expect(parseGoalArgs('clear the build warnings')).toEqual({
      kind: 'set',
      condition: 'clear the build warnings',
    })
  })

  test('condition over 4000 chars is rejected', () => {
    const long = 'x'.repeat(GOAL_MAX_CONDITION_LENGTH + 1)
    expect(parseGoalArgs(long)).toEqual({
      kind: 'too-long',
      length: GOAL_MAX_CONDITION_LENGTH + 1,
    })
    // Exactly at the limit is accepted
    const atLimit = 'x'.repeat(GOAL_MAX_CONDITION_LENGTH)
    expect(parseGoalArgs(atLimit)).toEqual({
      kind: 'set',
      condition: atLimit,
    })
  })
})

type OnDoneCall = {
  result?: string
  options?: Parameters<LocalJSXCommandOnDone>[1]
}

function createCommandHarness() {
  let state = {
    sessionHooks: new Map<string, SessionStore>(),
    activeGoal: undefined,
    lastGoalResult: undefined,
  } as unknown as AppState
  const onDoneCalls: OnDoneCall[] = []
  const onDone: LocalJSXCommandOnDone = (result, options) => {
    onDoneCalls.push({ result, options })
  }
  const context = {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    messages: [],
  } as unknown as ToolUseContext & LocalJSXCommandContext
  return {
    context,
    onDone,
    onDoneCalls,
    getState: () => state,
  }
}

describe('/goal command', () => {
  test('bare /goal with no active goal shows usage', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, '')
    expect(h.onDoneCalls).toHaveLength(1)
    expect(h.onDoneCalls[0]!.result).toContain('No active goal')
    expect(h.onDoneCalls[0]!.result).toContain('/goal <condition>')
    expect(h.onDoneCalls[0]!.options?.shouldQuery).toBeUndefined()
  })

  test('too-long condition is rejected without registering anything', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'x'.repeat(4001))
    expect(h.onDoneCalls[0]!.result).toContain('too long')
    expect(h.getState().activeGoal).toBeUndefined()
    expect(h.getState().sessionHooks.size).toBe(0)
  })

  test('setting a goal registers state and queries with the directive', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'all tests pass')

    const goal = h.getState().activeGoal
    expect(goal?.condition).toBe('all tests pass')
    expect(goal?.iterations).toBe(0)

    const { result, options } = h.onDoneCalls[0]!
    expect(result).toContain('Goal set: all tests pass')
    expect(options?.display).toBe('system')
    expect(options?.shouldQuery).toBe(true)
    expect(options?.metaMessages).toHaveLength(1)
    expect(options?.metaMessages?.[0]).toContain(
      'A session-scoped Stop hook is now active with condition: "all tests pass".',
    )
  })

  test('replacing a goal reports replacement', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'first')
    await call(h.onDone, h.context, 'second')
    expect(h.onDoneCalls[1]!.result).toContain('Goal replaced: second')
    expect(h.getState().activeGoal?.condition).toBe('second')
  })

  test('bare /goal with an active goal shows status', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'all tests pass')
    await call(h.onDone, h.context, '')
    const status = h.onDoneCalls[1]!.result
    expect(status).toContain('Goal active: all tests pass')
    expect(status).toContain('Iterations: 0')
    expect(status).toContain('/goal clear to stop early')
  })

  test('/goal clear removes the goal and confirms', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'all tests pass')
    await call(h.onDone, h.context, 'clear')
    expect(h.onDoneCalls[1]!.result).toBe('Goal cleared.')
    expect(h.getState().activeGoal).toBeUndefined()
    const stopHooks =
      [...h.getState().sessionHooks.values()].flatMap(
        s => s.hooks['Stop'] ?? [],
      ) ?? []
    expect(stopHooks.flatMap(m => m.hooks)).toHaveLength(0)
  })

  test('/goal clear without a goal reports nothing to clear', async () => {
    const h = createCommandHarness()
    await call(h.onDone, h.context, 'clear')
    expect(h.onDoneCalls[0]!.result).toBe('No active goal to clear.')
  })

  test('command opts in to headless (-p) mode via supportsNonInteractive', async () => {
    // Regression: headless.ts filters slash commands to prompt commands plus
    // local/local-jsx commands with supportsNonInteractive — without the
    // flag, `claudin -p '/goal ...'` fails with "Unknown skill: goal".
    const { default: goalCommand } = await import('./index.js')
    expect(goalCommand.type).toBe('local-jsx')
    expect(goalCommand.supportsNonInteractive).toBe(true)
  })
})
