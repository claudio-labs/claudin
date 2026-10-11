import { describe, expect, test } from 'bun:test'
import type { SetAppState } from 'src/agent/Task.js'
import {
  RULE_MAP_DISPLAY_MS,
  type RuleMapTaskState,
  type RuleMapTaskTimers,
  trackRuleMapSync,
} from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'
import { isBackgroundTask, isListedBackgroundTask } from 'src/agent/tasks/types.js'
import type { RuleMapSyncOutcome } from 'src/memory/instructions/ruleMapAutoSync.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

const HEALED: RuleMapSyncOutcome = {
  status: 'healed',
  path: '.claudin/rules/search-strategy.md',
  changes: [{ path: 'src/tools/', from: 682, to: 751 }],
}
const CURRENT: RuleMapSyncOutcome = { status: 'skipped', reason: 'already current' }

/**
 * A store holding only `tasks`, the evictions armed against it, and a slow
 * timer the test fires by hand — nothing waits on a real clock.
 */
function harness() {
  let state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    state = f(state)
  }
  const armed: { evict: () => void; delayMs: number }[] = []
  const slow: { show: (() => void) | null; disarmed: boolean } = {
    show: null,
    disarmed: false,
  }
  const timers: RuleMapTaskTimers = {
    afterSlowSync: show => {
      slow.show = show
      return () => {
        slow.disarmed = true
      }
    },
    evict: (evict, delayMs) => {
      armed.push({ evict, delayMs })
    },
  }
  const tasks = () => Object.values(state.tasks) as unknown as RuleMapTaskState[]
  return { setAppState, timers, armed, slow, tasks }
}

describe('trackRuleMapSync', () => {
  test('lists a sync that wrote, finished, without claiming work is in flight', async () => {
    const h = harness()
    expect(await trackRuleMapSync(h.setAppState, Promise.resolve(HEALED), h.timers)).toBe(HEALED)
    const [task] = h.tasks()
    expect(task).toMatchObject({ status: 'completed', notified: true, result: HEALED })
    // Listed in the footer and dialog, but the headless turn loop and the
    // kill hints read isBackgroundTask, and must not see a running task.
    expect(isListedBackgroundTask(task!)).toBe(true)
    expect(isBackgroundTask(task!)).toBe(false)
    expect(task!.outputFile).toBe('')
  })

  test('holds the notice for the display time, then evicts it', async () => {
    const h = harness()
    await trackRuleMapSync(h.setAppState, Promise.resolve(HEALED), h.timers)
    expect(h.armed.map(a => a.delayMs)).toEqual([RULE_MAP_DISPLAY_MS])
    h.armed[0]!.evict()
    expect(h.tasks()).toEqual([])
  })

  test('a sync that wrote nothing leaves no row', async () => {
    const h = harness()
    await trackRuleMapSync(h.setAppState, Promise.resolve(CURRENT), h.timers)
    expect(h.tasks()).toEqual([])
    expect(h.slow.disarmed).toBe(true)
  })

  test('a slow sync is listed running, then finished once it wrote', async () => {
    const h = harness()
    let resolve: (outcome: RuleMapSyncOutcome) => void = () => {}
    const tracked = trackRuleMapSync(
      h.setAppState,
      new Promise(r => {
        resolve = r
      }),
      h.timers,
    )
    h.slow.show!()
    expect(h.tasks()).toMatchObject([{ status: 'running', result: null }])
    resolve(HEALED)
    await tracked
    expect(h.tasks()).toMatchObject([{ status: 'completed', result: HEALED }])
    expect(h.armed).toHaveLength(1)
  })

  test('a slow sync that wrote nothing leaves at once', async () => {
    const h = harness()
    let resolve: (outcome: RuleMapSyncOutcome) => void = () => {}
    const tracked = trackRuleMapSync(
      h.setAppState,
      new Promise(r => {
        resolve = r
      }),
      h.timers,
    )
    h.slow.show!()
    resolve(CURRENT)
    await tracked
    expect(h.tasks()).toEqual([])
    expect(h.armed).toEqual([])
  })
})
