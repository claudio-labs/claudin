/**
 * Characterization of the background tasks dialog (/tasks, and the footer's
 * "view all"): how it groups and orders tasks, what the hint line offers for
 * the selected row, and what each key does — move, open, go back, stop,
 * foreground a teammate, close.
 *
 * The dialog is mounted with its real app-state provider; a tap component
 * hands the test that store, so the test can change tasks under the dialog
 * the way the rest of the REPL does, and read back what the dialog changed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { BackgroundTasksDialog } from 'src/agent/ui/tasks/BackgroundTasksDialog.js'
import { AppStateProvider, getDefaultAppState, useAppStateStore, type AppStateStore } from 'src/terminal/state/AppState.js'
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'
import { KEYS, mountInk, type Mounted } from 'src/agent/ui/__testutils__/inkMount.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentRow,
  containerRow,
  dreamRow,
  mcpRow,
  monitorRow,
  shellRow,
  tasksById,
  teammateRow,
  workflowRow,
} from 'src/agent/ui/tasks/__testutils__/backgroundRows.js'

const TIMEOUT = 40_000
const POINTER = '❯'
const DISMISSED = ['Background tasks dialog dismissed', { display: 'system' }]

let configDir = ''
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'bg-dialog-char-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

type Opened = Mounted & {
  done: unknown[][]
  store: () => AppStateStore
  setTasks: (update: (tasks: Record<string, BackgroundTaskState>) => Record<string, BackgroundTaskState>) => void
  /** The trimmed line holding `text`, or undefined. */
  line: (text: string) => string | undefined
}

function StoreTap({ onStore }: { onStore: (store: AppStateStore) => void }): null {
  onStore(useAppStateStore())
  return null
}

async function openDialog(
  tasks: Record<string, BackgroundTaskState>,
  options: { initialDetailTaskId?: string; state?: Record<string, unknown>; ready?: string } = {},
): Promise<Opened> {
  const done: unknown[][] = []
  let captured: AppStateStore | null = null
  const initial = { ...getDefaultAppState(), tasks, ...options.state }
  const ui = await mountInk(
    <AppStateProvider initialState={initial as never}>
      <StoreTap onStore={s => (captured = s)} />
      <BackgroundTasksDialog
        onDone={(...args) => {
          done.push(args)
        }}
        toolUseContext={{} as never}
        initialDetailTaskId={options.initialDetailTaskId}
      />
    </AppStateProvider>,
    110,
  )
  await ui.waitFor(options.ready ?? 'to close')
  const store = () => captured!
  return {
    ...ui,
    done,
    store,
    setTasks: update =>
      store().setState(prev => ({ ...prev, tasks: update(prev.tasks as never) as never })),
    line: text =>
      ui
        .screen()
        .split('\n')
        .find(l => l.includes(text))
        ?.trim(),
  }
}

async function withDialog(dialog: Promise<Opened>, body: (d: Opened) => Promise<void>): Promise<void> {
  const d = await dialog
  try {
    await body(d)
  } finally {
    await d.unmount()
  }
}

/** Lines between the title and the hint line, without the dialog border. */
function body(frame: string): string[] {
  const lines = frame.split('\n').map(l => l.replace(/^[│|]\s?/, '').replace(/\s*[│|]$/, '').trimEnd())
  const start = lines.findIndex(l => l.includes('Background tasks'))
  const end = lines.findIndex(l => l.includes('to close'))
  return lines.slice(start + 1, end).filter(l => l.trim() !== '' && !/^[─╭╰]+/.test(l.trim()))
}

describe('the list', () => {
  test(
    'no background task shows the empty state',
    async () => {
      await withDialog(openDialog({ b1: shellRow('b1', { status: 'completed' }), b2: shellRow('b2', { isBackgrounded: false }) }), async d => {
        const frame = d.screen()
        expect(frame).toContain('No tasks currently running')
        expect(frame).toContain('↑/↓ to select')
        expect(frame).not.toContain('Enter to view')
      })
    },
    TIMEOUT,
  )

  test(
    'tasks are grouped in a fixed section order, with counts and a running summary',
    async () => {
      const tasks = tasksById(
        dreamRow('d1', { description: 'Dreaming' }),
        workflowRow('w1', { workflowName: 'nightly' }),
        agentRow('a1', { description: 'Audit the parser' }),
        mcpRow('p1', { serverName: 'docs' }),
        containerRow('cache'),
        monitorRow('m1', { description: 'Tailing gateway' }),
        shellRow('b1', { command: 'npm run dev' }),
        teammateRow('t1', 'ada'),
        teammateRow('t2', 'bob', { isIdle: true }),
      )
      await withDialog(openDialog(tasks), async d => {
        const lines = body(d.screen()).map(l => l.trim())
        const order = [
          'Agents (2)',
          'Team: crew (3)',
          `${POINTER} @team-lead`,
          '@ada: working',
          '@bob: idle',
          'Shells (1)',
          'npm run dev (running)',
          'Monitors (1)',
          'Tailing gateway (running)',
          'Containers (1)',
          'cache-1 · up · :6379',
          'MCP (1)',
          'docs · connected · 3 tools',
          'Local agents (1)',
          'Audit the parser (running)',
          'Workflows (1)',
          'nightly (2 agents)',
          'Dreaming · starting · 4 sessions (running)',
        ]
        let cursor = -1
        for (const wanted of order) {
          const at = lines.findIndex((l, i) => i > cursor && l.includes(wanted))
          expect(at, `"${wanted}" after line ${cursor} in\n${lines.join('\n')}`).toBeGreaterThan(cursor)
          cursor = at
        }
        expect(d.screen()).toContain('3 agents · 1 active shell · 1 active agent')
      })
    },
    TIMEOUT,
  )

  test(
    'section headings for teammates and shells only appear when agents or other shells share the list',
    async () => {
      await withDialog(openDialog(tasksById(shellRow('b1', { command: 'one' }), shellRow('b2', { command: 'two' }))), async d => {
        expect(d.screen()).not.toContain('Shells (')
        expect(d.screen()).toContain('2 active shells')
      })
      await withDialog(openDialog(tasksById(teammateRow('t1', 'ada'), monitorRow('m1'))), async d => {
        expect(d.screen()).not.toContain('Agents (')
        expect(d.screen()).toContain('Team: crew (2)')
        expect(d.screen()).toContain('2 agents')
      })
    },
    TIMEOUT,
  )

  test(
    'running rows sort before pending ones, newest first within each',
    async () => {
      const tasks = tasksById(
        shellRow('b1', { command: 'old-running', startTime: 10 }),
        shellRow('b2', { command: 'pending-new', status: 'pending', startTime: 99 }),
        shellRow('b3', { command: 'new-running', startTime: 50 }),
        shellRow('b4', { command: 'pending-old', status: 'pending', startTime: 5 }),
      )
      await withDialog(openDialog(tasks), async d => {
        const names = body(d.screen())
          .map(l => l.match(/(\S+-\S+) \(/)?.[1])
          .filter(Boolean)
        expect(names).toEqual(['new-running', 'old-running', 'pending-new', 'pending-old'])
        expect(d.screen()).toContain('2 active shells')
      })
    },
    TIMEOUT,
  )

  test(
    'the foregrounded agent is left out, and the spinner tree takes the teammates',
    async () => {
      const tasks = tasksById(
        agentRow('a1', { description: 'Foreground one' }),
        agentRow('a2', { description: 'Background one' }),
        teammateRow('t1', 'ada'),
        shellRow('b1'),
      )
      await withDialog(openDialog(tasks, { state: { foregroundedTaskId: 'a1', expandedView: 'teammates' } }), async d => {
        const frame = d.screen()
        expect(frame).toContain('Background one')
        expect(frame).not.toContain('Foreground one')
        expect(frame).not.toContain('@ada')
        expect(frame).not.toContain('@team-lead')
        expect(frame).toContain('Local agents (1)')
      })
    },
    TIMEOUT,
  )
})

describe('the hint line follows the selected row', () => {
  const cases: Array<{ name: string; tasks: BackgroundTaskState[]; has: string[]; lacks: string[] }> = [
    {
      name: 'a running shell',
      tasks: [shellRow('b1'), shellRow('b2', { startTime: 1 })],
      has: ['Enter to view', 'x to stop', '←/Esc to close'],
      lacks: ['stop all agents', 'f to foreground'],
    },
    { name: 'a pending shell', tasks: [shellRow('b1', { status: 'pending' }), shellRow('b2', { status: 'pending' })], has: ['Enter to view'], lacks: ['x to stop'] },
    {
      name: 'a running teammate',
      tasks: [teammateRow('t1', 'ada', { startTime: 5 }), teammateRow('t2', 'bob')],
      has: ['Enter to view'],
      lacks: ['f to foreground', 'x to stop'],
    },
    { name: 'a connected MCP server', tasks: [mcpRow('p1'), mcpRow('p2')], has: ['Enter to view', 'x to disconnect'], lacks: [] },
    { name: 'a pending MCP server', tasks: [mcpRow('p1', { connectionType: 'pending' }), mcpRow('p2', { connectionType: 'pending' })], has: ['Enter to view'], lacks: ['x to'] },
    { name: 'a running container', tasks: [containerRow('c1'), containerRow('c2')], has: ['Enter to logs', 'x to stop container'], lacks: [] },
    { name: 'a running agent', tasks: [agentRow('a1'), agentRow('a2')], has: ['x to stop', 'ctrl+x ctrl+k to stop all agents'], lacks: [] },
  ]
  for (const c of cases) {
    test(
      c.name,
      async () => {
        await withDialog(openDialog(tasksById(...c.tasks)), async d => {
          const frame = d.screen()
          for (const text of c.has) expect(frame, `${c.name} should offer "${text}"`).toContain(text)
          for (const text of c.lacks) expect(frame, `${c.name} should not offer "${text}"`).not.toContain(text)
        })
      },
      TIMEOUT,
    )
  }

  test(
    'the leader row is selected first and offers no stop',
    async () => {
      await withDialog(openDialog(tasksById(teammateRow('t1', 'ada'), shellRow('b1'))), async d => {
        expect(d.line('@team-lead')).toStartWith(POINTER)
        expect(d.screen()).not.toContain('x to stop')
        await d.press(KEYS.down)
        await d.waitFor(f => (f.split('\n').find(l => l.includes('@ada')) ?? '').includes(POINTER))
        expect(d.screen()).toContain('f to foreground')
        expect(d.screen()).toContain('x to stop')
      })
    },
    TIMEOUT,
  )
})

describe('keys in the list', () => {
  test(
    'up and down move the pointer and stop at both ends',
    async () => {
      const tasks = tasksById(shellRow('b1', { command: 'first', startTime: 3 }), shellRow('b2', { command: 'second', startTime: 2 }), shellRow('b3', { command: 'third', startTime: 1 }))
      await withDialog(openDialog(tasks), async d => {
        const selected = () => body(d.screen()).find(l => l.includes(POINTER))?.match(/(first|second|third)/)?.[1]
        expect(selected()).toBe('first')
        const moves: Array<[string, string]> = [
          [KEYS.up, 'first'],
          [KEYS.down, 'second'],
          [KEYS.down, 'third'],
          [KEYS.down, 'third'],
          [KEYS.up, 'second'],
        ]
        for (const [key, expected] of moves) {
          await d.press(key)
          expect(selected()).toBe(expected)
        }
      })
    },
    TIMEOUT,
  )

  test(
    'left and Esc both close the dialog',
    async () => {
      for (const key of [KEYS.left, KEYS.esc]) {
        await withDialog(openDialog(tasksById(shellRow('b1'), shellRow('b2'))), async d => {
          await d.press(key, key === KEYS.esc ? 400 : 150)
          expect(d.done).toEqual([DISMISSED])
        })
      }
    },
    TIMEOUT,
  )

  // The shared kill dispatch is what `x` calls. A container or an MCP server
  // is not stopped from here: the request is parked in app state for the
  // confirmation dialog above, and the row stays.
  test(
    'x on a container parks a stop request for the selected one',
    async () => {
      const tasks = tasksById(containerRow('web', { startTime: 2 }), containerRow('db', { startTime: 1, startedByUs: false }))
      await withDialog(openDialog(tasks), async d => {
        await d.press(KEYS.down)
        await d.press('x')
        expect((d.store().getState() as unknown as { pendingContainerStop: unknown }).pendingContainerStop).toEqual({
          taskId: 'db',
          name: 'db-1',
          startedByUs: false,
        })
        expect(d.screen()).toContain('web-1 · up')
        expect(d.done).toEqual([])
      })
    },
    TIMEOUT,
  )

  test(
    'x on a connected MCP server parks a disconnect request',
    async () => {
      await withDialog(openDialog(tasksById(mcpRow('p1', { serverName: 'docs', toolCount: 5 }), shellRow('b1'))), async d => {
        await d.press(KEYS.down)
        await d.press('x')
        expect((d.store().getState() as unknown as { pendingMcpDisconnect: unknown }).pendingMcpDisconnect).toEqual({
          taskId: 'p1',
          serverName: 'docs',
          toolCount: 5,
        })
      })
    },
    TIMEOUT,
  )

  test(
    'x on a row with nothing to stop changes nothing',
    async () => {
      const tasks = tasksById(mcpRow('p1', { connectionType: 'pending' }), shellRow('b1', { status: 'pending' }))
      await withDialog(openDialog(tasks), async d => {
        const before = d.store().getState()
        for (const key of [KEYS.up, 'x', KEYS.down, 'x']) await d.press(key)
        expect(d.store().getState().tasks).toBe(before.tasks)
        expect((d.store().getState() as unknown as { pendingMcpDisconnect: unknown }).pendingMcpDisconnect).toBeNull()
      })
    },
    TIMEOUT,
  )

  test(
    'x on the leader does nothing',
    async () => {
      await withDialog(openDialog(tasksById(teammateRow('t1', 'ada'), shellRow('b1'))), async d => {
        const before = d.store().getState().tasks
        await d.press('x')
        expect(d.store().getState().tasks).toBe(before)
        expect(d.done).toEqual([])
      })
    },
    TIMEOUT,
  )

  test(
    'when the selected last row disappears the pointer moves to the new last row',
    async () => {
      const tasks = tasksById(shellRow('b1', { command: 'top', startTime: 2 }), shellRow('b2', { command: 'mid', startTime: 1 }), shellRow('b3', { command: 'end', startTime: 0 }))
      await withDialog(openDialog(tasks), async d => {
        await d.press(KEYS.down)
        await d.press(KEYS.down)
        expect(d.line('end')).toStartWith(POINTER)
        d.setTasks(({ b3: _gone, ...rest }) => rest)
        await d.waitFor(f => !f.includes('end (running)') && (f.split('\n').find(l => l.includes('mid')) ?? '').includes(POINTER))
      })
    },
    TIMEOUT,
  )

  test(
    'Enter on the leader, or f on it, returns to the leader view',
    async () => {
      for (const key of [KEYS.enter, 'f']) {
        await withDialog(openDialog(tasksById(teammateRow('t1', 'ada'), shellRow('b1')), { state: { viewingAgentTaskId: 't1', viewSelectionMode: 'viewing-agent' } }), async d => {
          await d.press(key)
          expect(d.done).toEqual([['Viewing leader', { display: 'system' }]])
          expect(d.store().getState().viewingAgentTaskId).toBeUndefined()
          expect(d.store().getState().viewSelectionMode).toBe('none')
        })
      }
    },
    TIMEOUT,
  )

  test(
    'f on a running teammate switches the view to it; f on anything else does nothing',
    async () => {
      await withDialog(openDialog(tasksById(teammateRow('t1', 'ada'), shellRow('b1'))), async d => {
        await d.press(KEYS.down)
        await d.press('f')
        expect(d.done).toEqual([['Viewing teammate', { display: 'system' }]])
        expect(d.store().getState().viewingAgentTaskId).toBe('t1')
        expect(d.store().getState().viewSelectionMode).toBe('viewing-agent')
      })
      await withDialog(openDialog(tasksById(shellRow('b1'), shellRow('b2'))), async d => {
        await d.press('f')
        expect(d.done).toEqual([])
        expect(d.store().getState().viewingAgentTaskId).toBeUndefined()
      })
    },
    TIMEOUT,
  )
})

describe('detail views', () => {
  test(
    'Enter opens the selected shell, and left comes back to the list',
    async () => {
      await withDialog(openDialog(tasksById(shellRow('b1', { command: 'npm run dev', startTime: 2 }), shellRow('b2', { command: 'other', startTime: 1 }))), async d => {
        await d.press(KEYS.enter)
        const detail = await d.waitFor('go back')
        expect(detail).toContain('npm run dev')
        expect(detail).not.toContain('Background tasks')
        await d.press(KEYS.left)
        await d.waitFor('Background tasks')
        expect(d.line('npm run dev')).toStartWith(POINTER)
        expect(d.done).toEqual([])
      })
    },
    TIMEOUT,
  )

  const openers: Array<{ name: string; tasks: BackgroundTaskState[]; downs: number; shows: string }> = [
    { name: 'a teammate', tasks: [teammateRow('t1', 'ada', { prompt: 'Refactor the lexer' }), shellRow('b1')], downs: 1, shows: 'ada' },
    { name: 'a local agent', tasks: [agentRow('a1', { description: 'Audit the parser' }), shellRow('b1')], downs: 1, shows: 'Audit the parser' },
    { name: 'a dream', tasks: [dreamRow('d1', { description: 'Dreaming' }), shellRow('b1')], downs: 1, shows: 'go back' },
    { name: 'an MCP server', tasks: [mcpRow('p1', { serverName: 'docs-server' }), shellRow('b1')], downs: 1, shows: 'docs-server' },
    { name: 'a container', tasks: [containerRow('cache'), shellRow('b1')], downs: 1, shows: 'Logs' },
  ]
  for (const o of openers) {
    test(
      `Enter opens ${o.name}, and left returns to the list`,
      async () => {
        await withDialog(openDialog(tasksById(...o.tasks)), async d => {
          for (let i = 0; i < o.downs; i++) await d.press(KEYS.down)
          await d.press(KEYS.enter)
          await d.waitFor(f => !f.includes('Background tasks') && f.includes(o.shows))
          await d.press(KEYS.left)
          await d.waitFor('Background tasks')
          expect(d.done).toEqual([])
        })
      },
      TIMEOUT,
    )
  }

  test(
    'a lone task opens straight into its detail, and left closes the dialog',
    async () => {
      await withDialog(openDialog(tasksById(shellRow('b1', { command: 'solo command' })), { ready: 'solo command' }), async d => {
        expect(d.screen()).not.toContain('Background tasks')
        await d.press(KEYS.left)
        expect(d.done).toEqual([DISMISSED])
      })
    },
    TIMEOUT,
  )

  test(
    'after skipping the list, a second task arriving makes left show the list instead of closing',
    async () => {
      await withDialog(openDialog(tasksById(shellRow('b1', { command: 'solo command' })), { ready: 'solo command' }), async d => {
        d.setTasks(tasks => ({ ...tasks, b2: shellRow('b2', { command: 'late arrival' }) }))
        await Bun.sleep(100)
        await d.press(KEYS.left)
        await d.waitFor('Background tasks')
        expect(d.screen()).toContain('late arrival')
        expect(d.done).toEqual([])
      })
    },
    TIMEOUT,
  )

  test(
    'a caller-chosen task opens directly, and the dialog closes when that task goes away',
    async () => {
      const tasks = tasksById(agentRow('a1', { description: 'Chosen agent' }), shellRow('b1'), shellRow('b2'))
      await withDialog(openDialog(tasks, { initialDetailTaskId: 'a1', ready: 'Chosen agent' }), async d => {
        expect(d.screen()).not.toContain('Background tasks')
        d.setTasks(all => ({ ...all, a1: { ...all.a1!, status: 'completed' } as never }))
        await d.waitFor(() => d.done.length > 0)
        expect(d.done).toEqual([DISMISSED])
      })
    },
    TIMEOUT,
  )

  test(
    'a detail opened from the list falls back to the list when its task ends',
    async () => {
      await withDialog(openDialog(tasksById(shellRow('b1', { command: 'will end', startTime: 2 }), shellRow('b2', { command: 'stays', startTime: 1 }))), async d => {
        await d.press(KEYS.enter)
        await d.waitFor('go back')
        d.setTasks(all => ({ ...all, b1: { ...all.b1!, status: 'completed' } as never }))
        await d.waitFor('Background tasks')
        expect(d.screen()).toContain('stays')
        expect(d.screen()).not.toContain('will end')
        expect(d.done).toEqual([])
      })
    },
    TIMEOUT,
  )

  test(
    'an unknown caller-chosen id renders nothing and closes the dialog',
    async () => {
      const done: unknown[][] = []
      const ui = await mountInk(
        <AppStateProvider initialState={{ ...getDefaultAppState(), tasks: tasksById(shellRow('b1'), shellRow('b2')) } as never}>
          <BackgroundTasksDialog onDone={(...args) => done.push(args)} toolUseContext={{} as never} initialDetailTaskId="nope" />
        </AppStateProvider>,
      ).catch(() => null)
      // The first frame may already be empty: nothing paints for a missing id.
      const deadline = Date.now() + 5_000
      while (done.length === 0 && Date.now() < deadline) await Bun.sleep(20)
      expect(done).toEqual([DISMISSED])
      await ui?.unmount()
    },
    TIMEOUT,
  )
})
