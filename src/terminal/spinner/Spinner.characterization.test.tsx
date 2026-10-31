// Characterization of Spinner.tsx as it behaves today — the "cover before
// touching" step ahead of a change to the count BriefIdleStatus shows.
//
// Determinism: SpinnerWithVerb is rendered with `prefersReducedMotion` set in
// the AppState settings, which takes it off the animation clock; the animated
// `Spinner` glyph is advanced with `setSystemTime`, which moves the shared
// clock's `Date.now()` without waiting on real time. The same lever ages a
// thinking block past its 2s minimum display.
//
// TodoV2 tasks reach the spinner through a file-watching store
// (`useTasksV2`), so that describe points CLAUDIN_CONFIG_DIR and
// CLAUDIN_TASK_LIST_ID at a temp directory and writes task JSON there; every
// env var and config key touched here is put back afterwards.

import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

import { getSpinnerVerbs } from 'src/agent/prompts/spinnerVerbs.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import {
  lastFrame,
  type MountedHook,
  mountHook,
  waitForCondition,
} from 'src/providers/ui/__testutils__/inkHookHarness.js'
import { BriefIdleStatus, Spinner, type SpinnerMode, SpinnerWithVerb } from 'src/terminal/spinner/Spinner.js'
import { getDefaultCharacters } from 'src/terminal/spinner/utils.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { type AppState, AppStateProvider, getDefaultAppState } from 'src/terminal/state/AppState.js'

type TaskEntry = AppState['tasks'][string]

const COLUMNS = 120
const ORB = getDefaultCharacters()

function appState(overrides: Partial<AppState> = {}, settings: Record<string, unknown> = {}): AppState {
  const base = getDefaultAppState()
  return {
    ...base,
    settings: { ...base.settings, prefersReducedMotion: true, spinnerTipsEnabled: true, ...settings },
    ...overrides,
  } as AppState
}

function ref<T>(value: T): React.RefObject<T> {
  return { current: value }
}

type VerbProps = React.ComponentProps<typeof SpinnerWithVerb>

function verbProps(overrides: Partial<VerbProps> = {}): VerbProps {
  return {
    mode: 'responding',
    loadingStartTimeRef: ref(Date.now()),
    totalPausedMsRef: ref(0),
    pauseStartTimeRef: ref<number | null>(null),
    responseLengthRef: ref(0),
    overrideMessage: 'Compiling',
    verbose: false,
    ...overrides,
  }
}

async function renderWith(node: React.ReactNode, state: AppState, columns = COLUMNS): Promise<string> {
  return renderToString(<AppStateProvider initialState={state}>{node}</AppStateProvider>, columns)
}

function teammate(id: string, name: string, overrides: Record<string, unknown> = {}): TaskEntry {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name} work`,
    startTime: Date.now() - 65_000,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@team`,
      agentName: name,
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'session',
    },
    prompt: 'do it',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    spinnerVerb: 'Researching',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  } as unknown as TaskEntry
}

function shellTask(id: string, overrides: Record<string, unknown> = {}): TaskEntry {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: 'sleep',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    command: 'sleep 100',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...overrides,
  } as unknown as TaskEntry
}

// Mounted roots are always torn down, even when an assertion throws first.
const mounted: MountedHook[] = []
async function mount(node: React.ReactNode, state: AppState): Promise<MountedHook> {
  const m = await mountHook(<AppStateProvider initialState={state}>{node}</AppStateProvider>, { columns: COLUMNS })
  mounted.push(m)
  return m
}
async function frameContaining(m: MountedHook, text: string, label: string): Promise<string> {
  await waitForCondition(() => lastFrame(m.streams.getOutput()).includes(text), { timeoutMs: 3000, label })
  return lastFrame(m.streams.getOutput())
}

afterEach(async () => {
  setSystemTime()
  while (mounted.length > 0) await mounted.pop()!.cleanup()
})

describe('BriefIdleStatus', () => {
  test('one running background bash task reads "1 in background"', async () => {
    const out = await renderWith(<BriefIdleStatus />, appState({ tasks: { b1: shellTask('b1') } }))
    expect(out).toContain('1 in background')
    expect(out).not.toContain('Reconnecting')
    expect(out).not.toContain('Disconnected')
  })

  test('remoteBackgroundTaskCount is added to the local count', async () => {
    const out = await renderWith(
      <BriefIdleStatus />,
      appState({ tasks: { b1: shellTask('b1') }, remoteBackgroundTaskCount: 2 }),
    )
    expect(out).toContain('3 in background')
  })

  test('remote tasks alone are counted', async () => {
    const out = await renderWith(<BriefIdleStatus />, appState({ remoteBackgroundTaskCount: 2 }))
    expect(out).toContain('2 in background')
  })

  test('a foreground bash task and a finished one are not counted', async () => {
    const out = await renderWith(
      <BriefIdleStatus />,
      appState({
        tasks: {
          f1: shellTask('f1', { isBackgrounded: false }),
          d1: shellTask('d1', { status: 'completed' }),
        },
      }),
    )
    expect(out.trim()).toBe('')
  })

  test('reconnecting shows "Reconnecting…"', async () => {
    const out = await renderWith(<BriefIdleStatus />, appState({ remoteConnectionStatus: 'reconnecting' }))
    expect(out).toContain('Reconnecting\u2026')
    expect(out).not.toContain('in background')
  })

  test('disconnected shows "Disconnected"', async () => {
    const out = await renderWith(<BriefIdleStatus />, appState({ remoteConnectionStatus: 'disconnected' }))
    expect(out).toContain('Disconnected')
    expect(out).not.toContain('Reconnecting')
  })

  test('nothing to say renders an empty block', async () => {
    const out = await renderWith(<BriefIdleStatus />, appState({ remoteConnectionStatus: 'connected' }))
    expect(out.trim()).toBe('')
  })

  test('the connection warning and the count share one line, the count pushed right', async () => {
    const columns = 60
    const out = await renderWith(
      <BriefIdleStatus />,
      appState({ remoteConnectionStatus: 'reconnecting', tasks: { b1: shellTask('b1') } }),
      columns,
    )
    const line = out.split('\n').find(l => l.includes('Reconnecting'))!
    // paddingLeft 2, then the pad fills columns - 2 - width(left) - width(right)
    const pad = columns - 2 - 'Reconnecting…'.length - '1 in background'.length
    expect(line.trimEnd()).toBe(`  Reconnecting\u2026${' '.repeat(pad)}1 in background`)
  })
})

describe('Spinner', () => {
  test('reduced motion renders a static dot', async () => {
    const out = await renderWith(<Spinner />, appState())
    expect(out.trim()).toBe('●')
  })

  test('the first frame is the first orbit glyph', async () => {
    const out = await renderWith(<Spinner />, appState({}, { prefersReducedMotion: false }))
    expect(out.trim()).toBe(ORB[0]!)
  })

  test('the glyph advances one orbit step per 120ms of clock time', async () => {
    const start = Date.now()
    setSystemTime(start)
    const m = await mount(<Spinner />, appState({}, { prefersReducedMotion: false }))
    await frameContaining(m, ORB[0]!, 'first orbit glyph')
    setSystemTime(start + 3 * 120 + 10)
    const frame = await frameContaining(m, ORB[3]!, 'fourth orbit glyph')
    expect(frame.trim()).toBe(ORB[3]!)
    // wraps around the orbit
    setSystemTime(start + (ORB.length + 1) * 120 + 10)
    expect((await frameContaining(m, ORB[1]!, 'wrapped glyph')).trim()).toBe(ORB[1]!)
  })
})

describe('SpinnerWithVerb — leader', () => {
  test('shows the override message with trailing dots', async () => {
    const out = await renderWith(<SpinnerWithVerb {...verbProps()} />, appState())
    expect(out).toContain('Compiling...')
    expect(out).not.toContain('Tip:')
  })

  test('without an override it picks one of the spinner verbs', async () => {
    const out = await renderWith(<SpinnerWithVerb {...verbProps({ overrideMessage: null })} />, appState())
    expect(getSpinnerVerbs().some(verb => out.includes(`${verb}...`))).toBe(true)
  })

  test('a spinner tip renders as "Tip: …"', async () => {
    const out = await renderWith(<SpinnerWithVerb {...verbProps({ spinnerTip: 'Press esc' })} />, appState())
    expect(out).toContain('Tip: Press esc')
  })

  test('verbose shows the suffix and the elapsed timer', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ verbose: true, spinnerSuffix: 'esc to interrupt' })} />,
      appState(),
    )
    expect(out).toContain('esc to interrupt')
    // "0s" or "0.0s" depending on formatDuration's precision setting
    expect(out).toMatch(/\(esc to interrupt · [\d.]+s\)/)
  })

  describe('time-based tips', () => {
    let savedBtw: number
    beforeAll(() => {
      savedBtw = getGlobalConfig().btwUseCount
      saveGlobalConfig(c => ({ ...c, btwUseCount: 0 }))
    })
    afterAll(() => {
      saveGlobalConfig(c => ({ ...c, btwUseCount: savedBtw }))
    })

    test('after 30 minutes it suggests /clear over the given tip', async () => {
      const out = await renderWith(
        <SpinnerWithVerb {...verbProps({ spinnerTip: 'Press esc', loadingStartTimeRef: ref(Date.now() - 1_900_000) })} />,
        appState(),
      )
      expect(out).toContain('Tip: Use /clear to start fresh when switching topics and free up context')
      expect(out).not.toContain('Press esc')
    })

    test('after 30 seconds, never having used /btw, it suggests /btw', async () => {
      const out = await renderWith(
        <SpinnerWithVerb {...verbProps({ loadingStartTimeRef: ref(Date.now() - 40_000) })} />,
        appState(),
      )
      expect(out).toContain("Tip: Use /btw to ask a quick side question without interrupting Claudin's current work")
    })

    test('the /btw tip stops once /btw has been used', async () => {
      saveGlobalConfig(c => ({ ...c, btwUseCount: 3 }))
      try {
        const out = await renderWith(
          <SpinnerWithVerb {...verbProps({ spinnerTip: 'Press esc', loadingStartTimeRef: ref(Date.now() - 40_000) })} />,
          appState(),
        )
        expect(out).toContain('Tip: Press esc')
        expect(out).not.toContain('/btw')
      } finally {
        saveGlobalConfig(c => ({ ...c, btwUseCount: 0 }))
      }
    })

    test('paused time does not count: elapsed is frozen at the pause', async () => {
      const start = Date.now() - 1_900_000
      const out = await renderWith(
        <SpinnerWithVerb
          {...verbProps({
            spinnerTip: 'Press esc',
            loadingStartTimeRef: ref(start),
            pauseStartTimeRef: ref<number | null>(start + 1_000),
          })}
        />,
        appState(),
      )
      expect(out).toContain('Tip: Press esc')
      expect(out).not.toContain('/clear')
      expect(out).not.toContain('/btw')
    })

    test('paused ms are subtracted from the elapsed time', async () => {
      const out = await renderWith(
        <SpinnerWithVerb
          {...verbProps({
            spinnerTip: 'Press esc',
            loadingStartTimeRef: ref(Date.now() - 1_900_000),
            totalPausedMsRef: ref(1_899_000),
          })}
        />,
        appState(),
      )
      expect(out).toContain('Tip: Press esc')
    })

    test('spinnerTipsEnabled: false suppresses the time-based tips but keeps the given tip', async () => {
      const out = await renderWith(
        <SpinnerWithVerb {...verbProps({ spinnerTip: 'Press esc', loadingStartTimeRef: ref(Date.now() - 1_900_000) })} />,
        appState({}, { spinnerTipsEnabled: false }),
      )
      expect(out).toContain('Tip: Press esc')
      expect(out).not.toContain('/clear')
    })
  })
})

describe('SpinnerWithVerb — thinking status', () => {
  let setModeExternal: ((mode: SpinnerMode) => void) | null = null
  function ModeHarness(props: VerbProps): React.ReactNode {
    const [mode, setMode] = React.useState<SpinnerMode>(props.mode)
    setModeExternal = setMode
    return <SpinnerWithVerb {...props} mode={mode} />
  }

  test('thinking mode shows "thinking", then "thought for Ns" once it stops after 2s', async () => {
    const start = Date.now()
    setSystemTime(start)
    const m = await mount(<ModeHarness {...verbProps({ mode: 'thinking' })} />, appState())
    await frameContaining(m, 'thinking', 'thinking status')
    setSystemTime(start + 5_000)
    setModeExternal!('responding')
    const frame = await frameContaining(m, 'thought for 5s', 'thought-for status')
    expect(frame).not.toContain('thinking')
  })

  test('a thinking block shorter than 2s keeps "thinking" on screen', async () => {
    const m = await mount(<ModeHarness {...verbProps({ mode: 'thinking' })} />, appState())
    await frameContaining(m, 'thinking', 'thinking status')
    setModeExternal!('responding')
    await Bun.sleep(50)
    const frame = lastFrame(m.streams.getOutput())
    expect(frame).toContain('thinking')
    expect(frame).not.toContain('thought for')
  })

  test('a mode that never thought shows no thinking status', async () => {
    const m = await mount(<ModeHarness {...verbProps({ mode: 'responding' })} />, appState())
    const frame = await frameContaining(m, 'Compiling...', 'spinner row')
    expect(frame).not.toContain('thinking')
    expect(frame).not.toContain('thought for')
  })
})

describe('SpinnerWithVerb — teammates', () => {
  test('leader idle with a teammate working: static "Idle · teammates running"', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ leaderIsIdle: true })} />,
      appState({ tasks: { t1: teammate('t1', 'researcher') } }),
    )
    expect(out).toContain('Idle · teammates running')
    expect(out).not.toContain('Compiling')
  })

  test('leader idle with every teammate idle: just "Idle"', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ leaderIsIdle: true })} />,
      appState({ tasks: { t1: teammate('t1', 'researcher', { isIdle: true }) } }),
    )
    expect(out).toContain('Idle')
    expect(out).not.toContain('teammates running')
  })

  test('leader idle in the teammates view also draws the tree with the leader idle', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ leaderIsIdle: true })} />,
      appState({ tasks: { t1: teammate('t1', 'researcher') }, expandedView: 'teammates' }),
    )
    expect(out).toContain('Idle · teammates running')
    expect(out).toContain('team-lead')
    expect(out).toContain('researcher')
  })

  test('leader idle but no running teammate falls through to the spinner row', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ leaderIsIdle: true })} />,
      appState({ tasks: { t1: teammate('t1', 'researcher', { status: 'completed' }) } }),
    )
    expect(out).toContain('Compiling...')
    expect(out).not.toContain('Idle')
  })

  test('viewing the only (idle) teammate: "Worked for <duration>"', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps()} />,
      appState({ tasks: { t1: teammate('t1', 'researcher', { isIdle: true }) }, viewingAgentTaskId: 't1' }),
    )
    expect(out).toMatch(/Worked for 1m \d+s/)
    expect(out).not.toContain('Compiling')
  })

  test('viewing an idle teammate while another works: "Idle"', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps()} />,
      appState({
        tasks: {
          t1: teammate('t1', 'researcher', { isIdle: true }),
          t2: teammate('t2', 'writer'),
        },
        viewingAgentTaskId: 't1',
      }),
    )
    expect(out).toContain('Idle')
    expect(out).not.toContain('Worked for')
    expect(out).not.toContain('team-lead')
  })

  test('viewing an idle teammate in the teammates view draws the tree', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps()} />,
      appState({
        tasks: { t1: teammate('t1', 'researcher', { isIdle: true }), t2: teammate('t2', 'writer') },
        viewingAgentTaskId: 't1',
        expandedView: 'teammates',
      }),
    )
    expect(out).toContain('team-lead')
    expect(out).toContain('writer')
  })

  test('viewing a working teammate uses its verb and names it in the status', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps()} />,
      appState({ tasks: { t1: teammate('t1', 'researcher') }, viewingAgentTaskId: 't1' }),
    )
    expect(out).toContain('Researching...')
    expect(out).not.toContain('Compiling')
    expect(out).toContain('(esc to interrupt researcher)')
  })

  test('viewing a non-teammate task id is treated as viewing the leader', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps()} />,
      appState({ tasks: { b1: shellTask('b1') }, viewingAgentTaskId: 'b1' }),
    )
    expect(out).toContain('Compiling...')
  })

  test('running teammates add their tokens to the leader row', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ verbose: true })} />,
      appState({
        tasks: {
          t1: teammate('t1', 'researcher', { progress: { tokenCount: 1000 } }),
          t2: teammate('t2', 'writer', { progress: { tokenCount: 500 } }),
          t3: teammate('t3', 'done', { status: 'completed', progress: { tokenCount: 9000 } }),
        },
      }),
    )
    expect(out).toContain('Compiling...')
    expect(out).toContain('1.5k tokens')
  })

  test('in the teammates view the tokens are not aggregated and the tree is drawn', async () => {
    const out = await renderWith(
      <SpinnerWithVerb {...verbProps({ verbose: true })} />,
      appState({
        tasks: { t1: teammate('t1', 'researcher', { progress: { tokenCount: 1000 } }) },
        expandedView: 'teammates',
      }),
    )
    // the tree line carries the teammate's own tokens; the leader row does not
    const leaderRow = out.split('\n').find(l => l.includes('Compiling...'))!
    expect(leaderRow).not.toContain('tokens')
    expect(out).toContain('@researcher')
    expect(out).toContain('team-lead')
    expect(out).toContain('researcher')
  })
})

describe('SpinnerWithVerb — TodoV2 tasks', () => {
  const saved = {
    configDir: process.env.CLAUDIN_CONFIG_DIR,
    listId: process.env.CLAUDIN_TASK_LIST_ID,
    enableTasks: process.env.CLAUDIN_ENABLE_TASKS,
  }
  let root = ''
  let seq = 0

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'spinner-char-'))
    process.env.CLAUDIN_CONFIG_DIR = root
    process.env.CLAUDIN_ENABLE_TASKS = '1'
  })
  afterAll(() => {
    restore('CLAUDIN_CONFIG_DIR', saved.configDir)
    restore('CLAUDIN_TASK_LIST_ID', saved.listId)
    restore('CLAUDIN_ENABLE_TASKS', saved.enableTasks)
    rmSync(root, { recursive: true, force: true })
  })

  type TodoSeed = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; blockedBy?: string[] }
  function seedTasks(tasks: TodoSeed[]): void {
    const listId = `spinner-list-${++seq}`
    process.env.CLAUDIN_TASK_LIST_ID = listId
    const dir = join(root, 'tasks', listId)
    mkdirSync(dir, { recursive: true })
    for (const t of tasks) {
      writeFileSync(
        join(dir, `${t.id}.json`),
        JSON.stringify({ description: '', blocks: [], blockedBy: [], ...t }),
      )
    }
  }

  test('the in-progress todo names the verb and the first unblocked pending one is "Next"', async () => {
    seedTasks([
      { id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { id: '2', subject: 'Blocked step', status: 'pending', blockedBy: ['1'] },
      { id: '3', subject: 'Ship it', status: 'pending' },
    ])
    const m = await mount(<SpinnerWithVerb {...verbProps({ overrideMessage: null, spinnerTip: 'Press esc' })} />, appState())
    const frame = await frameContaining(m, 'Next: Ship it', 'next task')
    expect(frame).toContain('Writing tests...')
    expect(frame).not.toContain('Blocked step')
    expect(frame).not.toContain('Tip:')
  })

  test('a todo without activeForm lends its subject; with every pending one blocked, the first is "Next"', async () => {
    seedTasks([
      { id: '1', subject: 'Refactor parser', status: 'in_progress' },
      { id: '2', subject: 'Second', status: 'pending', blockedBy: ['1'] },
      { id: '3', subject: 'Third', status: 'pending', blockedBy: ['1'] },
    ])
    const m = await mount(<SpinnerWithVerb {...verbProps({ overrideMessage: null })} />, appState())
    const frame = await frameContaining(m, 'Next: Second', 'fallback next task')
    expect(frame).toContain('Refactor parser...')
  })

  test('a blocker that is completed does not block', async () => {
    seedTasks([
      { id: '1', subject: 'Done already', status: 'completed' },
      { id: '2', subject: 'Was blocked', status: 'pending', blockedBy: ['1'] },
      { id: '3', subject: 'Other', status: 'pending', blockedBy: ['9'] },
    ])
    const m = await mount(<SpinnerWithVerb {...verbProps()} />, appState())
    const frame = await frameContaining(m, 'Next: Was blocked', 'next after completed blocker')
    expect(frame).toContain('Compiling...')
  })

  test('the override message wins over the in-progress todo', async () => {
    seedTasks([{ id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' }])
    const m = await mount(<SpinnerWithVerb {...verbProps({ spinnerTip: 'Press esc' })} />, appState())
    await waitForCondition(() => m.streams.getOutput().length > 0, { label: 'first frame' })
    // the store fetches asynchronously; give it a beat to land
    await Bun.sleep(100)
    const frame = lastFrame(m.streams.getOutput())
    expect(frame).toContain('Compiling...')
    expect(frame).not.toContain('Writing tests')
    expect(frame).toContain('Tip: Press esc')
  })

  test('the tasks view lists every todo instead of the Next line', async () => {
    seedTasks([
      { id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { id: '2', subject: 'Ship it', status: 'pending' },
    ])
    const m = await mount(<SpinnerWithVerb {...verbProps()} />, appState({ expandedView: 'tasks' }))
    const frame = await frameContaining(m, 'Ship it', 'task list')
    expect(frame).toContain('Write tests')
    expect(frame).not.toContain('Next:')
  })
})
