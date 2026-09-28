/**
 * The detector's lifecycle, and the place its parts meet. It is idle until
 * initialize(), starting while the locations are worked out, then watching
 * until dispose(), which is final until resetForTesting() re-arms it. While
 * watching, the watcher feeds a batch and a settled batch reloads; skills
 * discovered mid-session go straight to the subscribers.
 */
import { type ChangeBatch, createChangeBatch } from 'src/skills/changeDetection/changeBatch.js'
import type { FileWatcher, WatchFiles, WatchTimings } from 'src/skills/changeDetection/fileWatcher.js'
import { type ReloadDeps, reloadSkills } from 'src/skills/changeDetection/reload.js'
import { createSubscribers } from 'src/skills/changeDetection/subscribers.js'

type SkillChangeTimings = WatchTimings & {
  /** The quiet period a batch waits out before it reloads. */
  reloadDebounce: number
}

/** Milliseconds; an absent key keeps its default. */
export type SkillChangeTimingOverrides = Partial<SkillChangeTimings>

export type DetectorDeps = Omit<ReloadDeps, 'notifySubscribers'> & {
  /** The watched locations that exist right now. */
  findLocations: () => Promise<readonly string[]>
  watchFiles: WatchFiles
  /** Only the memoized command lists, which a discovery load extends. */
  dropCommandLists: () => void
  /** The loader's signal for skills discovered mid-session. */
  onDynamicSkillsLoaded: (callback: () => void) => void
  /** Returns the function that unregisters the cleanup. */
  registerCleanup: (cleanup: () => Promise<void>) => () => void
  logError: (error: unknown) => void
}

type SkillChangeDetector = {
  initialize: () => Promise<void>
  /** Returns the function that removes the listener. */
  subscribe: (listener: () => void) => () => void
  dispose: () => Promise<void>
  resetForTesting: (overrides?: SkillChangeTimingOverrides) => Promise<void>
}

type Watching = {
  watcher: FileWatcher
  batch: ChangeBatch
  unregisterCleanup: () => void
}

type State =
  | { phase: 'idle' }
  | { phase: 'starting'; started: Promise<void> }
  | { phase: 'watching'; watching: Watching }
  | { phase: 'disposed' }

const DEFAULT_TIMINGS: SkillChangeTimings = {
  stabilityThreshold: 1000,
  pollInterval: 500,
  reloadDebounce: 300,
  chokidarInterval: 2000,
}

export function createSkillChangeDetector(deps: DetectorDeps): SkillChangeDetector {
  const subscribers = createSubscribers(deps.logError)
  const reloadDeps: ReloadDeps = {
    isBlockedByHooks: deps.isBlockedByHooks,
    dropSkillCaches: deps.dropSkillCaches,
    notifySubscribers: subscribers.notify,
  }
  let state: State = { phase: 'idle' }
  let timings = DEFAULT_TIMINGS
  // Bumped by dispose() and resetForTesting(), so a start that was still
  // working out the locations when either came knows it is stale.
  let generation = 0
  let relayingDiscoveries = false

  function initialize(): Promise<void> {
    if (state.phase === 'starting') return state.started
    if (state.phase !== 'idle') return Promise.resolve()
    relayDiscoveriesOnce()
    const startedIn = generation
    // Never rejects: the caller at startup does not await it.
    const started = startWatching(startedIn).catch((error: unknown) => {
      deps.logError(error)
      if (startedIn === generation) state = { phase: 'idle' }
    })
    state = { phase: 'starting', started }
    return started
  }

  async function startWatching(startedIn: number): Promise<void> {
    const locations = await deps.findLocations()
    if (startedIn !== generation) return
    state = { phase: 'watching', watching: watchLocations(locations) }
  }

  function watchLocations(locations: readonly string[]): Watching {
    const batch = createChangeBatch(timings.reloadDebounce, changed => {
      void reloadSkills(changed, reloadDeps).catch(deps.logError)
    })
    const watcher = deps.watchFiles(locations, timings, {
      onChange: batch.add,
      onError: deps.logError,
    })
    return { watcher, batch, unregisterCleanup: deps.registerCleanup(dispose) }
  }

  function relayDiscoveriesOnce(): void {
    if (relayingDiscoveries) return
    relayingDiscoveries = true
    // For good: dispose() and resets leave the relay in place.
    deps.onDynamicSkillsLoaded(() => {
      // The new skills join the command lists; the listings read from disk
      // stay cached, and no hook runs.
      deps.dropCommandLists()
      subscribers.notify()
    })
  }

  /** Ends whatever runs now; resolves once the watcher is closed. */
  function stop(): Promise<void> {
    generation++
    subscribers.clear()
    if (state.phase !== 'watching') return Promise.resolve()
    const { watcher, batch, unregisterCleanup } = state.watching
    const closed = watcher.close()
    batch.cancel()
    unregisterCleanup()
    return closed
  }

  async function dispose(): Promise<void> {
    const closed = stop()
    state = { phase: 'disposed' }
    await closed
  }

  async function resetForTesting(overrides: SkillChangeTimingOverrides = {}): Promise<void> {
    const closed = stop()
    state = { phase: 'idle' }
    timings = withDefaults(overrides)
    await closed
  }

  return { initialize, subscribe: subscribers.subscribe, dispose, resetForTesting }
}

function withDefaults(overrides: SkillChangeTimingOverrides): SkillChangeTimings {
  return {
    stabilityThreshold: overrides.stabilityThreshold ?? DEFAULT_TIMINGS.stabilityThreshold,
    pollInterval: overrides.pollInterval ?? DEFAULT_TIMINGS.pollInterval,
    reloadDebounce: overrides.reloadDebounce ?? DEFAULT_TIMINGS.reloadDebounce,
    chokidarInterval: overrides.chokidarInterval ?? DEFAULT_TIMINGS.chokidarInterval,
  }
}
