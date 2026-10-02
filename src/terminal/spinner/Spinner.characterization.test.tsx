/**
 * Characterization of the working indicator (Spinner.tsx): the verb line the
 * REPL shows while a turn runs, the tip under it, the idle line when only
 * teammates work, and the bare one-glyph spinner dialogs use.
 *
 * Mounted in a real Ink tree over a fake TTY with real app state. The verb
 * comes from a real settings file in a temp config directory, the task list
 * from real task files, and the elapsed time from the refs the REPL hands in.
 *
 * BriefIdleStatus is not pinned: it only renders in brief mode, which this
 * build never turns on, and it reports the remote-session connection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as React from 'react'
import { createTask } from 'src/agent/tasks/tasks.js'
import { setIsInteractive, getIsInteractive } from 'src/platform/bootstrap/state.js'
import { saveGlobalConfig, getGlobalConfig } from 'src/platform/config/config.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { createFakeTerminal, type FakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { useSandbox } from 'src/terminal/prompt-input/__testutils__/promptRig.js'
import { getDefaultCharacters } from 'src/terminal/spinner/index.js'
import { Spinner, SpinnerWithVerb, type SpinnerMode } from 'src/terminal/spinner/Spinner.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const SLOW = 20_000
const sandbox = useSandbox()

let taskList = 0
const interactiveBefore = getIsInteractive()
const btwBefore = getGlobalConfig().btwUseCount
beforeEach(() => {
  taskList += 1
  process.env.CLAUDIN_TASK_LIST_ID = `spinner-characterization-${process.pid}-${taskList}`
  saveGlobalConfig(c => ({ ...c, btwUseCount: 0 }))
})
afterEach(() => {
  delete process.env.CLAUDIN_TASK_LIST_ID
  setIsInteractive(interactiveBefore)
  saveGlobalConfig(c => ({ ...c, btwUseCount: btwBefore }))
})

function writeUserSettings(settings: object): void {
  const path = getSettingsFilePathForSource('userSettings') as string
  expect(path.startsWith(sandbox().configDir)).toBe(true)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings))
  resetSettingsCache()
}

/** Every verb the spinner may pick is this one, so the line is predictable. */
function onlyVerb(verb: string, extra: object = {}): void {
  writeUserSettings({ spinnerVerbs: { mode: 'replace', verbs: [verb] }, ...extra })
}

type Clock = { startedAgo: number; pausedFor?: number; pausedAgo?: number | null; characters?: number }

type Line = {
  mode?: SpinnerMode
  clock?: Clock
  tip?: string
  overrideMessage?: string | null
  leaderIsIdle?: boolean
  hasActiveTools?: boolean
}

type Indicator = {
  terminal: FakeTerminal
  rows: () => string[]
  redraw: (line: Line) => Promise<void>
  waitFor: (check: (screen: string) => boolean, what: string) => Promise<void>
}

const open: Array<() => void> = []
afterEach(() => {
  while (open.length) open.pop()?.()
})

async function showIndicator(line: Line, state: Partial<AppState> = {}, columns = 120): Promise<Indicator> {
  const terminal = createFakeTerminal({ columns })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  open.push(() => {
    root.unmount()
    terminal.close()
  })
  const initialState = { ...getDefaultAppState(), ...state } as AppState
  const refsFor = (clock: Clock) => {
    const now = Date.now()
    return {
      loadingStartTimeRef: { current: now - clock.startedAgo },
      totalPausedMsRef: { current: clock.pausedFor ?? 0 },
      pauseStartTimeRef: { current: clock.pausedAgo == null ? null : now - clock.pausedAgo },
      responseLengthRef: { current: clock.characters ?? 0 },
    }
  }
  let refs = refsFor(line.clock ?? { startedAgo: 1_000 })
  const draw = (next: Line) => {
    if (next.clock) refs = refsFor(next.clock)
    root.render(
      <AppStateProvider initialState={initialState}>
        <SpinnerWithVerb
          mode={next.mode ?? 'responding'}
          {...refs}
          spinnerTip={next.tip}
          overrideMessage={next.overrideMessage}
          verbose={false}
          hasActiveTools={next.hasActiveTools}
          leaderIsIdle={next.leaderIsIdle}
        />
      </AppStateProvider>,
    )
  }
  const rows = () =>
    terminal
      .screen()
      .split('\n')
      .map(row => row.trimEnd())
      .filter(row => row !== '')
  const waitFor = async (check: (screen: string) => boolean, what: string) => {
    const deadline = Date.now() + 5_000
    while (!check(terminal.screen())) {
      if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}\n${terminal.screen()}`)
      await Bun.sleep(20)
    }
  }
  draw(line)
  await waitFor(screen => screen.trim() !== '', 'the first frame')
  return {
    terminal,
    rows,
    redraw: async next => {
      draw(next)
      await Bun.sleep(80)
    },
    waitFor,
  }
}

function idleTeammate(id: string, name: string, over: object = {}): AppState['tasks'][string] {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name} helps`,
    identity: { agentId: `${name}@crew`, agentName: name, teamName: 'crew', color: 'blue', planModeRequired: false, parentSessionId: 'lead' },
    prompt: 'help',
    // Resting by default; a test passes isIdle: false for one that works.
    ...{ isIdle: true, permissionMode: 'default', shutdownRequested: false, awaitingPlanApproval: false },
    messages: [],
    pendingUserMessages: [],
    spinnerVerb: 'Juggling',
    startTime: Date.now() - 90_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
    ...over,
  } as unknown as AppState['tasks'][string]
}

// =====================================================================================

describe('the verb line', () => {
  test(
    'shows a configured verb with an ellipsis, the elapsed time and the token count',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ clock: { startedAgo: 12_000, characters: 8_000 } })
      const [first] = indicator.rows()
      expect(first).toMatch(/^\S Pondering(…|\.\.\.) \(12s · ↓ 2\.0k tokens\)$/)
    },
    SLOW,
  )

  test(
    'an override message replaces the verb',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ overrideMessage: 'Compacting conversation' })
      expect(indicator.rows()[0]).toContain('Compacting conversation')
      expect(indicator.rows()[0]).not.toContain('Pondering')
    },
    SLOW,
  )

  test(
    'paused time does not count: a pause in progress freezes the clock at its start',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ clock: { startedAgo: 40_000, pausedFor: 10_000, pausedAgo: 20_000 } })
      expect(indicator.rows()[0]).toContain('(10s')
    },
    SLOW,
  )

  test(
    'thinking shows with the effort, then how long it took once it stops',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ mode: 'thinking' }, { effortValue: 'high' } as Partial<AppState>)
      await indicator.waitFor(screen => screen.includes('thinking with high effort'), 'the thinking note')
      await indicator.redraw({ mode: 'responding' })
      // Thinking stays on screen for at least two seconds before the duration replaces it.
      expect(indicator.rows()[0]).toContain('thinking')
      // A thought under a second still reads as one second.
      await indicator.waitFor(screen => screen.includes('thought for 1s'), 'the thinking duration')
      await indicator.waitFor(screen => !screen.includes('thought for'), 'the duration to clear')
    },
    SLOW,
  )

  test(
    'a thought longer than two seconds shows its duration at once',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ mode: 'thinking' })
      await Bun.sleep(2_100)
      await indicator.redraw({ mode: 'responding' })
      expect(indicator.rows()[0]).toContain('thought for 2s')
    },
    SLOW,
  )

  test(
    'the legacy adaptive effort adds no effort suffix',
    async () => {
      onlyVerb('Pondering')
      const indicator = await showIndicator({ mode: 'thinking' }, { effortValue: 'adaptive' } as unknown as Partial<AppState>)
      await indicator.waitFor(screen => screen.includes('thinking)'), 'the thinking note')
      expect(indicator.rows()[0]).not.toContain('effort')
    },
    SLOW,
  )
})

describe('the tip under the verb', () => {
  const cases: Array<{ when: string; startedAgo: number; tip?: string; settings?: object; btw?: number; expected: string | null }> = [
    { when: 'a short turn with a tip', startedAgo: 5_000, tip: 'Press esc to interrupt', expected: 'Tip: Press esc to interrupt' },
    { when: 'a short turn without one', startedAgo: 5_000, expected: null },
    {
      when: 'a turn past 30 seconds, /btw never used',
      startedAgo: 31_000,
      tip: 'ignored',
      expected: "Tip: Use /btw to ask a quick side question without interrupting Claudin's current work",
    },
    { when: 'a turn past 30 seconds, /btw already used', startedAgo: 31_000, tip: 'Press esc', btw: 2, expected: 'Tip: Press esc' },
    {
      when: 'a turn past 30 minutes',
      startedAgo: 1_800_001,
      btw: 2,
      expected: 'Tip: Use /clear to start fresh when switching topics and free up context',
    },
    { when: 'tips switched off in settings', startedAgo: 1_800_001, tip: 'Press esc', settings: { spinnerTipsEnabled: false }, expected: 'Tip: Press esc' },
  ]
  for (const { when, startedAgo, tip, settings, btw, expected } of cases) {
    test(
      `for ${when}`,
      async () => {
        onlyVerb('Pondering', settings)
        saveGlobalConfig(c => ({ ...c, btwUseCount: btw ?? 0 }))
        const indicator = await showIndicator({ clock: { startedAgo }, tip })
        const tipRow = indicator.rows().find(row => row.includes('⎿'))
        expect(tipRow?.replace(/^\s*⎿\s+/, '') ?? null).toBe(expected)
      },
      SLOW,
    )
  }
})

describe('with a task list', () => {
  async function plan(tasks: Array<{ subject: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; blockedBy?: string[] }>) {
    setIsInteractive(true)
    const list = process.env.CLAUDIN_TASK_LIST_ID as string
    for (const task of tasks) {
      await createTask(list, {
        subject: task.subject,
        description: task.subject,
        activeForm: task.activeForm,
        status: task.status,
        blocks: [],
        blockedBy: task.blockedBy ?? [],
      })
    }
  }

  test(
    'the task in progress names the verb, and the first unblocked pending task is next',
    async () => {
      onlyVerb('Pondering')
      await plan([
        { subject: 'Fix parser', status: 'in_progress', activeForm: 'Fixing the parser' },
        { subject: 'Ship release', status: 'pending', blockedBy: ['3'] },
        { subject: 'Write docs', status: 'pending' },
      ])
      const indicator = await showIndicator({ tip: 'Press esc' })
      await indicator.waitFor(screen => screen.includes('Fixing the parser'), 'the task verb')
      expect(indicator.rows().some(row => row.endsWith('Next: Write docs'))).toBe(true)
      expect(indicator.terminal.screen()).not.toContain('Press esc')
    },
    SLOW,
  )

  test(
    'a task in progress with no active form lends its subject; a blocked pending task is still next when it is the only one',
    async () => {
      onlyVerb('Pondering')
      await plan([
        { subject: 'Audit imports', status: 'in_progress' },
        { subject: 'Ship release', status: 'pending', blockedBy: ['1'] },
      ])
      const indicator = await showIndicator({})
      await indicator.waitFor(screen => screen.includes('Audit imports'), 'the subject as verb')
      expect(indicator.rows().some(row => row.endsWith('Next: Ship release'))).toBe(true)
    },
    SLOW,
  )

  test(
    'with the task view expanded, the whole list replaces the tip',
    async () => {
      onlyVerb('Pondering')
      await plan([
        { subject: 'Fix parser', status: 'in_progress', activeForm: 'Fixing the parser' },
        { subject: 'Write docs', status: 'pending' },
      ])
      const indicator = await showIndicator({ tip: 'Press esc' }, { expandedView: 'tasks' } as Partial<AppState>)
      await indicator.waitFor(screen => screen.includes('Write docs') && screen.includes('Fix parser'), 'the list')
      expect(indicator.terminal.screen()).not.toContain('Next:')
    },
    SLOW,
  )
})

describe('with teammates', () => {
  test(
    'the leader idle while teammates run shows a still idle line',
    async () => {
      onlyVerb('Pondering')
      const working = { t1: idleTeammate('t1', 'ada', { isIdle: false }) }
      const indicator = await showIndicator({ leaderIsIdle: true }, { tasks: working } as Partial<AppState>)
      expect(indicator.rows()).toEqual(['✻ Idle · teammates running'])
    },
    SLOW,
  )

  test(
    'the leader idle with every teammate idle drops the running note',
    async () => {
      onlyVerb('Pondering')
      const resting = { t1: idleTeammate('t1', 'ada') }
      const indicator = await showIndicator({ leaderIsIdle: true }, { tasks: resting } as Partial<AppState>)
      expect(indicator.rows()).toEqual(['✻ Idle'])
    },
    SLOW,
  )

  test(
    'the idle line keeps the teammate tree when it is expanded',
    async () => {
      onlyVerb('Pondering')
      const working = { t1: idleTeammate('t1', 'ada', { isIdle: false }) }
      const indicator = await showIndicator({ leaderIsIdle: true }, { tasks: working, expandedView: 'teammates' } as Partial<AppState>)
      expect(indicator.rows()[0]).toBe('✻ Idle · teammates running')
      expect(indicator.terminal.screen()).toContain('ada')
    },
    SLOW,
  )

  test(
    'viewing an idle teammate while all are idle shows how long it worked',
    async () => {
      onlyVerb('Pondering')
      const state = { tasks: { t1: idleTeammate('t1', 'ada') }, viewingAgentTaskId: 't1' } as Partial<AppState>
      const indicator = await showIndicator({}, state)
      expect(indicator.rows()[0]).toMatch(/^✻ Worked for 1m 3\ds$/)
    },
    SLOW,
  )

  test(
    'viewing an idle teammate while another still works shows Idle, and the tree when expanded',
    async () => {
      onlyVerb('Pondering')
      const tasks = { t1: idleTeammate('t1', 'ada'), t2: idleTeammate('t2', 'bo', { isIdle: false }) }
      const viewing = await showIndicator({}, { tasks, viewingAgentTaskId: 't1' } as Partial<AppState>)
      expect(viewing.rows()).toEqual(['✻ Idle'])
      const expanded = await showIndicator(
        { leaderIsIdle: false },
        { tasks, viewingAgentTaskId: 't1', expandedView: 'teammates' } as Partial<AppState>,
      )
      expect(expanded.rows()[0]).toBe('✻ Idle')
      expect(expanded.terminal.screen()).toContain('bo')
    },
    SLOW,
  )

  test(
    'viewing a working teammate shows its own verb',
    async () => {
      onlyVerb('Pondering')
      const tasks = { t1: idleTeammate('t1', 'ada', { isIdle: false, spinnerVerb: 'Juggling' }) }
      const indicator = await showIndicator({}, { tasks, viewingAgentTaskId: 't1' } as Partial<AppState>)
      expect(indicator.rows()[0]).toContain('Juggling')
      expect(indicator.rows()[0]).not.toContain('Pondering')
    },
    SLOW,
  )

  test(
    'a working teammate without a verb of its own falls back to the leader pick',
    async () => {
      onlyVerb('Pondering')
      const tasks = { t1: idleTeammate('t1', 'ada', { isIdle: false, spinnerVerb: undefined }) }
      const indicator = await showIndicator({}, { tasks, viewingAgentTaskId: 't1' } as Partial<AppState>)
      expect(indicator.rows()[0]).toContain('Pondering')
    },
    SLOW,
  )

  test(
    'with the teammate tree expanded the leader line stays and the tree follows',
    async () => {
      onlyVerb('Pondering')
      const tasks = { t1: idleTeammate('t1', 'ada', { isIdle: false, progress: { tokenCount: 5_000 } }) }
      const indicator = await showIndicator({ tip: 'Press esc' }, { tasks, expandedView: 'teammates' } as Partial<AppState>)
      expect(indicator.rows()[0]).toContain('Pondering')
      expect(indicator.terminal.screen()).toContain('ada')
      expect(indicator.terminal.screen()).not.toContain('Tip:')
    },
    SLOW,
  )

  test(
    'tokens of running teammates are added to the leader count',
    async () => {
      onlyVerb('Pondering')
      const tasks = {
        t1: idleTeammate('t1', 'ada', { isIdle: false, progress: { tokenCount: 3_000 } }),
        t2: idleTeammate('t2', 'bo', { isIdle: false, progress: {} }),
        t3: idleTeammate('t3', 'cy', { status: 'completed', progress: { tokenCount: 9_000 } }),
      }
      const indicator = await showIndicator({ clock: { startedAgo: 3_000, characters: 4_000 } }, { tasks } as Partial<AppState>)
      expect(indicator.rows()[0]).toContain('4.0k tokens')
    },
    SLOW,
  )
})

describe('Spinner', () => {
  async function showGlyph(settings: object = {}): Promise<FakeTerminal> {
    writeUserSettings(settings)
    const terminal = createFakeTerminal({ columns: 20 })
    const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
    open.push(() => {
      root.unmount()
      terminal.close()
    })
    root.render(
      <AppStateProvider initialState={getDefaultAppState()}>
        <Spinner />
      </AppStateProvider>,
    )
    const deadline = Date.now() + 3_000
    while (terminal.screen().trim() === '' && Date.now() < deadline) await Bun.sleep(20)
    return terminal
  }

  test(
    'animates through the default frames',
    async () => {
      const terminal = await showGlyph()
      const frames = new Set(getDefaultCharacters())
      const seen = new Set<string>()
      const deadline = Date.now() + 2_000
      while (seen.size < 2 && Date.now() < deadline) {
        seen.add(terminal.screen().trim())
        await Bun.sleep(30)
      }
      expect(seen.size).toBeGreaterThanOrEqual(2)
      for (const glyph of seen) expect(frames.has(glyph)).toBe(true)
    },
    SLOW,
  )

  test(
    'with reduced motion it is a still dot',
    async () => {
      const terminal = await showGlyph({ prefersReducedMotion: true })
      expect(terminal.screen().trim()).toBe('●')
      await Bun.sleep(300)
      expect(terminal.screen().trim()).toBe('●')
    },
    SLOW,
  )
})
