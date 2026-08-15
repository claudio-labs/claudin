import { describe, expect, test } from 'bun:test'
import { createCoalescedUpdater } from 'src/platform/install/coalescedUpdater.js'

const INTERVAL_MS = 16
const FLUSH_WAIT_MS = INTERVAL_MS * 3

function makeHarness() {
  let state: string[] = []
  let applyCalls = 0
  const updater = createCoalescedUpdater<string[]>(f => {
    applyCalls++
    state = f(state)
  }, INTERVAL_MS)
  return {
    updater,
    get state() {
      return state
    },
    get applyCalls() {
      return applyCalls
    },
  }
}

describe('createCoalescedUpdater', () => {
  test('leading edge: first enqueue after idle applies immediately', () => {
    const h = makeHarness()
    h.updater.enqueue(prev => [...prev, 'a'])
    expect(h.applyCalls).toBe(1)
    expect(h.state).toEqual(['a'])
  })

  test('updates inside the interval batch into one apply, order preserved', async () => {
    const h = makeHarness()
    h.updater.enqueue(prev => [...prev, 'a']) // leading — applies now
    h.updater.enqueue(prev => [...prev, 'b'])
    h.updater.enqueue(prev => [...prev, 'c'])
    h.updater.enqueue(() => []) // reset composes in order too
    h.updater.enqueue(prev => [...prev, 'd'])

    expect(h.applyCalls).toBe(1)
    expect(h.state).toEqual(['a'])

    await Bun.sleep(FLUSH_WAIT_MS)
    expect(h.applyCalls).toBe(2)
    expect(h.state).toEqual(['d'])
  })

  test('flush applies pending immediately and clears the timer', async () => {
    const h = makeHarness()
    h.updater.enqueue(prev => [...prev, 'a'])
    h.updater.enqueue(prev => [...prev, 'b'])
    h.updater.flush()
    expect(h.applyCalls).toBe(2)
    expect(h.state).toEqual(['a', 'b'])

    await Bun.sleep(FLUSH_WAIT_MS)
    expect(h.applyCalls).toBe(2) // no stray trailing apply
  })

  test('flush with nothing pending is a no-op', () => {
    const h = makeHarness()
    h.updater.flush()
    expect(h.applyCalls).toBe(0)
  })

  test('cancel drops pending updates without applying', async () => {
    const h = makeHarness()
    h.updater.enqueue(prev => [...prev, 'a'])
    h.updater.enqueue(prev => [...prev, 'b'])
    h.updater.cancel()
    expect(h.state).toEqual(['a']) // leading apply happened before cancel

    await Bun.sleep(FLUSH_WAIT_MS)
    expect(h.applyCalls).toBe(1)
    expect(h.state).toEqual(['a'])

    // Updater still usable after cancel.
    h.updater.enqueue(prev => [...prev, 'c'])
    h.updater.flush()
    expect(h.state).toEqual(['a', 'c'])
  })
})
