import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SetAppState } from 'src/agent/Task.js'
import {
  type RuleMapTaskState,
  trackRuleMapSync,
} from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'
import {
  RULE_MAP_KILLSWITCH,
  RULE_MAP_RELATIVE_PATH,
  type RuleMapSyncOutcome,
} from 'src/memory/instructions/ruleMapAutoSync.js'
import {
  drainPendingRuleMapSync,
  executeRuleMapSync,
  getLastRuleMapRun,
  initRuleMapSync,
  type RuleMapSchedulerDeps,
  resetRuleMapSyncForTesting,
  syncRuleMapIfEnabled,
  syncRuleMapNow,
} from 'src/memory/instructions/ruleMapScheduler.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

const HEALED: RuleMapSyncOutcome = {
  status: 'healed',
  path: '.claudin/rules/search-strategy.md',
  changes: [{ path: 'src/tools/', from: 682, to: 751 }],
}
const CURRENT: RuleMapSyncOutcome = { status: 'skipped', reason: 'already current' }

/** The real footer row, with timers that never wait: no slow row, evictions dropped. */
const track: RuleMapSchedulerDeps['track'] = (setAppState, sync) =>
  trackRuleMapSync(setAppState, sync, {
    afterSlowSync: () => () => {},
    evict: () => {},
  })

/** Lets queued microtasks run until `done` says so — a sync can sit behind an await. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await Promise.resolve()
  expect(done()).toBe(true)
}

/** Fake deps whose fingerprint is whatever the test last set it to. */
function fakes(outcomes: RuleMapSyncOutcome[] = [CURRENT]) {
  const state = { index: 'a', map: 'm', syncs: 0 }
  const deps: Partial<RuleMapSchedulerDeps> = {
    root: () => '/repo',
    fingerprint: async () => ({ index: state.index, map: state.map }),
    sync: async () => {
      const outcome = outcomes[Math.min(state.syncs, outcomes.length - 1)]!
      state.syncs++
      return outcome
    },
    disabledForProject: () => false,
    interactive: () => true,
    now: () => 1_000,
    track,
  }
  return { state, deps }
}

function store() {
  let state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    state = f(state)
  }
  const tasks = () => Object.values(state.tasks) as unknown as RuleMapTaskState[]
  return { setAppState, tasks }
}

// The real deps sync the project root, which under `bun test` is this
// checkout — and an ambient killswitch would turn the real-repo test below
// into a silent skip. Both are pinned here and put back after.
const savedKillswitch = process.env[RULE_MAP_KILLSWITCH]
beforeAll(() => {
  delete process.env[RULE_MAP_KILLSWITCH]
})
afterAll(() => {
  if (savedKillswitch === undefined) delete process.env[RULE_MAP_KILLSWITCH]
  else process.env[RULE_MAP_KILLSWITCH] = savedKillswitch
})
afterEach(() => {
  resetRuleMapSyncForTesting()
})

describe('executeRuleMapSync', () => {
  test('does nothing until initialized, so a test driving stop hooks writes no map', async () => {
    const { state, deps } = fakes()
    // Belt and braces: if the guard ever fell through to the real deps, they
    // would sync this checkout. The killswitch turns that into a recorded
    // skip, which is what the assertion below can see.
    process.env[RULE_MAP_KILLSWITCH] = '1'
    try {
      await executeRuleMapSync({})
    } finally {
      delete process.env[RULE_MAP_KILLSWITCH]
    }
    expect(getLastRuleMapRun()).toBeNull()
    initRuleMapSync(deps)
    await executeRuleMapSync({})
    expect(state.syncs).toBe(1)
  })

  test('syncs on the first turn, then not again while nothing changed', async () => {
    const { state, deps } = fakes()
    initRuleMapSync(deps)
    await executeRuleMapSync({})
    await executeRuleMapSync({})
    await executeRuleMapSync({})
    expect(state.syncs).toBe(1)
  })

  test('syncs again once the index moves', async () => {
    const { state, deps } = fakes()
    initRuleMapSync(deps)
    await executeRuleMapSync({})
    state.index = 'b'
    await executeRuleMapSync({})
    expect(state.syncs).toBe(2)
  })

  test('takes in the map stat its own write produced', async () => {
    // The write moves the map's stat. Without re-reading it the next turn
    // would sync only to find its own output current.
    const { state, deps } = fakes([HEALED, CURRENT])
    initRuleMapSync({
      ...deps,
      sync: async () => {
        state.syncs++
        state.map = 'after-write'
        return HEALED
      },
    })
    await executeRuleMapSync({})
    await executeRuleMapSync({})
    expect(state.syncs).toBe(1)
  })

  test('does not absorb an index change made while it was writing', async () => {
    const { state, deps } = fakes()
    initRuleMapSync({
      ...deps,
      sync: async () => {
        state.syncs++
        state.map = 'after-write'
        state.index = 'staged-meanwhile'
        return HEALED
      },
    })
    await executeRuleMapSync({})
    await executeRuleMapSync({})
    expect(state.syncs).toBe(2)
  })

  test('retries on the next turn after a run that failed', async () => {
    const { state, deps } = fakes([{ status: 'skipped', reason: 'error' }, CURRENT])
    initRuleMapSync(deps)
    await executeRuleMapSync({})
    await executeRuleMapSync({})
    expect(state.syncs).toBe(2)
  })

  test('a turn that ends mid-sync joins it instead of starting another', async () => {
    const { state, deps } = fakes()
    let release = () => {}
    initRuleMapSync({
      ...deps,
      sync: () =>
        new Promise(resolve => {
          state.syncs++
          release = () => resolve(CURRENT)
        }),
    })
    const first = executeRuleMapSync({})
    const second = executeRuleMapSync({})
    expect(second).toBe(first)
    await Promise.resolve()
    release()
    await first
    expect(state.syncs).toBe(1)
  })

  test('/map off stops it for the project', async () => {
    const { state, deps } = fakes()
    initRuleMapSync({ ...deps, disabledForProject: () => true })
    await executeRuleMapSync({})
    expect(state.syncs).toBe(0)
  })

  test('a write is announced in the transcript and listed in the footer', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync(deps)
    const s = store()
    const notices: string[] = []
    const levels: unknown[] = []
    await executeRuleMapSync({
      setAppState: s.setAppState,
      appendSystemMessage: msg => {
        notices.push(String(msg.content))
        levels.push('level' in msg ? msg.level : undefined)
      },
    })
    expect(notices).toEqual([
      'Navigation map · .claudin/rules/search-strategy.md · updated · src/tools/ 682→751',
    ])
    // SystemTextMessage hides an 'info' line outside verbose mode, which is how
    // the first build of this shipped a notice nobody could see.
    expect(levels).toEqual(['suggestion'])
    expect(s.tasks()).toHaveLength(1)
    expect(s.tasks()[0]).toMatchObject({
      type: 'rule_map',
      status: 'completed',
      result: HEALED,
    })
  })

  test('a sync that wrote nothing says nothing and lists nothing', async () => {
    const { deps } = fakes([CURRENT])
    initRuleMapSync(deps)
    const s = store()
    const notices: string[] = []
    await executeRuleMapSync({
      setAppState: s.setAppState,
      appendSystemMessage: msg => notices.push(String(msg.content)),
    })
    expect(notices).toEqual([])
    expect(s.tasks()).toEqual([])
  })

  test('headless lists nothing: there is no footer, and registerTask would emit a dangling SDK event', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync({ ...deps, interactive: () => false })
    const s = store()
    const original = console.error
    const printed: string[] = []
    console.error = (...args: unknown[]) => {
      printed.push(args.join(' '))
    }
    try {
      await executeRuleMapSync({ setAppState: s.setAppState })
    } finally {
      console.error = original
    }
    expect(s.tasks()).toEqual([])
    expect(printed.join('\n')).toContain('Navigation map · .claudin/rules/search-strategy.md · updated')
  })

  test('a caller that reports the outcome itself gets no notice of its own', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync({ ...deps, interactive: () => false })
    const original = console.error
    const printed: string[] = []
    console.error = (...args: unknown[]) => {
      printed.push(args.join(' '))
    }
    try {
      await syncRuleMapNow({ announce: false })
    } finally {
      console.error = original
    }
    expect(printed).toEqual([])
  })

  test('records the run for /map status', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync(deps)
    await executeRuleMapSync({})
    expect(getLastRuleMapRun()).toEqual({ at: 1_000, outcome: HEALED, trigger: 'turn' })
  })
})

describe('the real fingerprint, over a real repo', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function run(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
  }

  function addFiles(root: string, dir: string, count: number): void {
    mkdirSync(join(root, 'src', dir), { recursive: true })
    for (let i = 0; i < count; i++) {
      writeFileSync(join(root, 'src', dir, `f${i}.ts`), 'x\n')
    }
  }

  test('skips a turn that touched nothing git tracks, and heals one that did', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mapsched-'))
    roots.push(root)
    run(root, ['init', '-q'])
    addFiles(root, 'core', 8)
    run(root, ['add', '-A'])

    let clock = 0
    initRuleMapSync({
      root: () => root,
      disabledForProject: () => false,
      interactive: () => true,
      now: () => ++clock,
    })
    await executeRuleMapSync({})
    expect(getLastRuleMapRun()?.outcome.status).toBe('created')
    const created = getLastRuleMapRun()?.at

    // Untracked files are not in the index, so this turn changes nothing.
    addFiles(root, 'grown', 40)
    await executeRuleMapSync({})
    expect(getLastRuleMapRun()?.at).toBe(created)

    run(root, ['add', '-A'])
    await executeRuleMapSync({})
    expect(getLastRuleMapRun()?.outcome.status).toBe('healed')
    expect(readFileSync(join(root, RULE_MAP_RELATIVE_PATH), 'utf8')).toContain(
      'grown/ (40)',
    )
  })
})

describe('syncRuleMapNow', () => {
  test('ignores the fingerprint and the project switch, and records a command run', async () => {
    const { state, deps } = fakes([CURRENT])
    initRuleMapSync({ ...deps, disabledForProject: () => true })
    await syncRuleMapNow()
    await syncRuleMapNow()
    expect(state.syncs).toBe(2)
    expect(getLastRuleMapRun()?.trigger).toBe('command')
  })

  test('a turn that ends during it joins it rather than writing twice', async () => {
    const { state, deps } = fakes()
    let release = () => {}
    initRuleMapSync({
      ...deps,
      sync: () =>
        new Promise(resolve => {
          state.syncs++
          release = () => resolve(CURRENT)
        }),
    })
    const command = syncRuleMapNow()
    const turn = executeRuleMapSync({})
    await until(() => state.syncs === 1)
    release()
    await Promise.all([command, turn])
    expect(state.syncs).toBe(1)
  })

  test('waits for a turn already syncing instead of racing it', async () => {
    const { state, deps } = fakes()
    const releases: (() => void)[] = []
    initRuleMapSync({
      ...deps,
      sync: () =>
        new Promise(resolve => {
          state.syncs++
          releases.push(() => resolve(CURRENT))
        }),
    })
    const turn = executeRuleMapSync({})
    const command = syncRuleMapNow()
    await until(() => state.syncs === 1)
    // The command's own sync must not have started while the turn's runs.
    expect(state.syncs).toBe(1)
    releases[0]!()
    await turn
    await until(() => state.syncs === 2)
    releases[1]!()
    await command
  })

  test('does not absorb an index change made while it was writing', async () => {
    const { state, deps } = fakes()
    initRuleMapSync({
      ...deps,
      sync: async () => {
        state.syncs++
        state.map = 'after-write'
        state.index = 'staged-meanwhile'
        return HEALED
      },
    })
    await syncRuleMapNow()
    await executeRuleMapSync({})
    expect(state.syncs).toBe(2)
  })

  test('a write stays a write when the fingerprint after it cannot be read', async () => {
    const { deps } = fakes([HEALED])
    let reads = 0
    initRuleMapSync({
      ...deps,
      fingerprint: async () => {
        if (++reads > 1) throw new Error('EACCES')
        return { index: 'a', map: 'm' }
      },
    })
    expect(await syncRuleMapNow()).toEqual(HEALED)
  })
})

describe('drainPendingRuleMapSync', () => {
  test('waits for a command queued behind the turn, not just the turn', async () => {
    const { state, deps } = fakes()
    const releases: (() => void)[] = []
    initRuleMapSync({
      ...deps,
      sync: () =>
        new Promise(resolve => {
          state.syncs++
          releases.push(() => resolve(CURRENT))
        }),
    })
    void executeRuleMapSync({})
    const command = syncRuleMapNow()
    let drained = false
    const drain = drainPendingRuleMapSync().then(() => {
      drained = true
    })
    await until(() => state.syncs === 1)
    releases[0]!()
    await until(() => state.syncs === 2)
    expect(drained).toBe(false)
    releases[1]!()
    await command
    await drain
    expect(drained).toBe(true)
  })
})

describe('syncRuleMapIfEnabled', () => {
  test('respects /map off — /init was not asked to override it', async () => {
    const { state, deps } = fakes([HEALED])
    initRuleMapSync({ ...deps, disabledForProject: () => true })
    expect(await syncRuleMapIfEnabled()).toEqual({
      status: 'skipped',
      reason: 'off for this project',
    })
    expect(state.syncs).toBe(0)
  })

  test('syncs, and announces the write, when the project has it on', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync(deps)
    const notices: string[] = []
    await syncRuleMapIfEnabled({
      appendSystemMessage: msg => notices.push(String(msg.content)),
    })
    expect(notices).toHaveLength(1)
  })

  test('never throws, even when the switch cannot be read', async () => {
    const { deps } = fakes([HEALED])
    initRuleMapSync({
      ...deps,
      disabledForProject: () => {
        throw new Error('config unreadable')
      },
    })
    expect(await syncRuleMapIfEnabled()).toEqual({ status: 'skipped', reason: 'error' })
  })
})
