/**
 * The two places the rewrite deliberately departs from the old detector,
 * which the characterization suite does not pin: a dispose() or a reset that
 * arrives while initialize() works out the locations stops that watcher from
 * starting, and each subscriber runs on its own. The watcher, the hooks and
 * the caches are fakes; the lifecycle, the batch, the reload and the
 * subscribers are the real ones.
 *
 * bun test fails a test during which a promise rejection goes unhandled, and
 * does not pass it to process listeners, so the tests only give one the time
 * to surface.
 */
import { describe, expect, test } from 'bun:test'

import type { WatchHandlers } from 'src/skills/changeDetection/fileWatcher.js'
import { createSkillChangeDetector, type DetectorDeps } from 'src/skills/changeDetection/lifecycle.js'
import type { SkillChangeTimingOverrides } from 'src/skills/skillChangeDetector.js'

/** A change reloads on the next timer tick. */
const NO_QUIET_PERIOD: SkillChangeTimingOverrides = { reloadDebounce: 0 }

type Harness = {
  deps: DetectorDeps
  /** What the fakes and the subscribers saw, in order. */
  events: string[]
  errors: unknown[]
  /** The locations of every watcher started. */
  watched: (readonly string[])[]
  liveCleanups: () => number
  /** A changed file, reported by the running watcher. */
  change: (path: string) => void
  /** A discovery load, as the skills loader signals it. */
  discover: () => void
}

function makeDeps(findLocations: DetectorDeps['findLocations'] = async () => ['/skills']): Harness {
  const events: string[] = []
  const errors: unknown[] = []
  const watched: (readonly string[])[] = []
  let running: WatchHandlers | undefined
  let discovered: (() => void) | undefined
  let liveCleanups = 0
  const deps: DetectorDeps = {
    findLocations,
    watchFiles: (locations, _timings, handlers) => {
      watched.push(locations)
      running = handlers
      return {
        close: async () => {
          running = undefined
        },
      }
    },
    isBlockedByHooks: async changedFile => {
      events.push(`hooks ${changedFile}`)
      return false
    },
    dropSkillCaches: () => events.push('drop skill caches'),
    dropCommandLists: () => events.push('drop command lists'),
    onDynamicSkillsLoaded: callback => {
      discovered = callback
    },
    registerCleanup: () => {
      liveCleanups++
      return () => {
        liveCleanups--
      }
    },
    logError: error => errors.push(error),
  }
  return {
    deps,
    events,
    errors,
    watched,
    liveCleanups: () => liveCleanups,
    change: path => {
      if (running === undefined) throw new Error('no watcher is running')
      running.onChange(path)
    },
    discover: () => {
      if (discovered === undefined) throw new Error('discovery loads are not relayed')
      discovered()
    },
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(5)
  }
}

describe('a dispose() or reset during start-up', () => {
  test('a dispose() while the locations are worked out keeps the watcher from starting', async () => {
    const locations = Promise.withResolvers<readonly string[]>()
    const harness = makeDeps(() => locations.promise)
    const detector = createSkillChangeDetector(harness.deps)

    const initializing = detector.initialize()
    await detector.dispose()
    locations.resolve(['/skills'])
    await initializing

    expect(harness.watched).toEqual([])
    expect(harness.liveCleanups()).toBe(0)
    // Still off: until a reset, initialize() does nothing after dispose().
    await detector.initialize()
    expect(harness.watched).toEqual([])
  })

  test('a reset while the locations are worked out leaves one watcher, the one started after it', async () => {
    const stale = Promise.withResolvers<readonly string[]>()
    const fresh = Promise.withResolvers<readonly string[]>()
    const answers = [stale.promise, fresh.promise]
    const harness = makeDeps(() => answers.shift() ?? Promise.reject(new Error('asked too often')))
    const detector = createSkillChangeDetector(harness.deps)

    const first = detector.initialize()
    await detector.resetForTesting()
    const second = detector.initialize()
    // The stale start finishes last, after the fresh one is already watching.
    fresh.resolve(['/fresh'])
    await second
    stale.resolve(['/stale'])
    await first

    expect(harness.watched).toEqual([['/fresh']])
    expect(harness.liveCleanups()).toBe(1)
    expect(harness.errors).toEqual([])
  })
})

describe('each subscriber runs on its own', () => {
  test('one that throws during a reload is logged, and the ones after it still hear, after the caches are dropped', async () => {
    const harness = makeDeps()
    const detector = createSkillChangeDetector(harness.deps)
    await detector.resetForTesting(NO_QUIET_PERIOD)
    const broken = new Error('broken subscriber')
    detector.subscribe(() => {
      harness.events.push('first subscriber')
      throw broken
    })
    detector.subscribe(() => harness.events.push('second subscriber'))
    await detector.initialize()

    harness.change('/skills/a/SKILL.md')
    await waitUntil(() => harness.events.includes('second subscriber'))
    await sleep(20)

    expect(harness.events).toEqual([
      'hooks /skills/a/SKILL.md',
      'drop skill caches',
      'first subscriber',
      'second subscriber',
    ])
    expect(harness.errors).toEqual([broken])
  })

  test('one that throws during a discovery load is logged, and the ones after it still hear', async () => {
    const harness = makeDeps()
    const detector = createSkillChangeDetector(harness.deps)
    const broken = new Error('broken subscriber')
    detector.subscribe(() => {
      harness.events.push('first subscriber')
      throw broken
    })
    detector.subscribe(() => harness.events.push('second subscriber'))
    await detector.initialize()

    expect(() => harness.discover()).not.toThrow()

    expect(harness.events).toEqual(['drop command lists', 'first subscriber', 'second subscriber'])
    expect(harness.errors).toEqual([broken])
  })

  test('an async one whose promise rejects is logged rather than left unhandled', async () => {
    const harness = makeDeps()
    const detector = createSkillChangeDetector(harness.deps)
    const broken = new Error('broken async subscriber')
    detector.subscribe(async () => {
      throw broken
    })
    detector.subscribe(() => harness.events.push('second subscriber'))
    await detector.initialize()

    harness.discover()
    await sleep(20)

    expect(harness.events).toEqual(['drop command lists', 'second subscriber'])
    expect(harness.errors).toEqual([broken])
  })
})
