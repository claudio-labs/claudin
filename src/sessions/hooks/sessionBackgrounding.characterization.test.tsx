/**
 * Characterization of the REPL's backgrounding pieces and of the file-history
 * restore on resume, written before their clean-base rewrite:
 *
 * - `SessionBackgroundHint` owns Ctrl+B while foreground work runs: it sends
 *   every foreground task to the background and remembers, in the global
 *   config, that the user has done so once.
 * - `useSessionBackgrounding` is the REPL's side of an agent task brought to
 *   the foreground: it mirrors the task's messages and loading state into the
 *   main view, hands the view back when the task ends or is aborted, and
 *   gives Ctrl+B a handler that sends the task back (or, with nothing
 *   foregrounded, asks the caller to background the current query).
 * - `useFileHistorySnapshotInit` hands the REPL, once, the file-history state
 *   rebuilt from a resumed session's snapshots.
 *
 * Each runs in a small host component inside the app shell on the fake
 * terminal. Tasks are registered with the task module's own functions; the
 * REPL's setters are plain recorders, since they are what the hook drives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { join, relative } from 'path'
import React from 'react'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { registerAgentForeground } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { getIsNonInteractiveSession, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { agent, loadLatest, writeSession } from 'src/sessions/__testutils__/restoreHarness.js'
import { useFileHistorySnapshotInit } from 'src/sessions/hooks/useFileHistorySnapshotInit.js'
import { useSessionBackgrounding } from 'src/sessions/hooks/useSessionBackgrounding.js'
import { KEYS, mountInApp, type Picker, useResumeWorld } from 'src/sessions/ui/__testutils__/resumeRig.js'
import { SessionBackgroundHint } from 'src/sessions/ui/SessionBackgroundHint.js'
import type { FileHistorySnapshot, FileHistoryState } from 'src/shared/fs/fileHistory.js'
import type { Message } from 'src/shared/types/message.js'
import { Box, Text } from 'src/terminal/ink.js'
import type { AppState } from 'src/terminal/state/AppState.js'

const TIMEOUT = 20_000
const world = useResumeWorld()

let wasInteractive: boolean
beforeEach(() => {
  wasInteractive = !getIsNonInteractiveSession()
  setIsInteractive(true)
})
afterEach(() => {
  setIsInteractive(wasInteractive)
})

/** Registers a foreground agent task the way the Agent tool does; returns its id and its background signal. */
function foregroundAgent(app: Picker, name = 'helper') {
  const agentId = `a${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const { taskId, backgroundSignal } = registerAgentForeground({
    agentId,
    description: `${name} at work`,
    prompt: 'Look into the parser.',
    selectedAgent: agent(name),
    setAppState: app.setState,
  })
  let signalled = false
  void backgroundSignal.then(() => {
    signalled = true
  })
  return { taskId, signalled: () => signalled }
}

function patchTask(app: Picker, taskId: string, patch: Record<string, unknown>): void {
  app.setState(prev => ({ ...prev, tasks: { ...prev.tasks, [taskId]: { ...prev.tasks[taskId]!, ...patch } as never } }))
}

const isBackgrounded = (state: AppState, taskId: string) =>
  (state.tasks[taskId] as { isBackgrounded?: boolean } | undefined)?.isBackgrounded

describe('SessionBackgroundHint', () => {
  async function mountHint() {
    const app = await mountInApp(
      <Box flexDirection="column">
        <Text>above the hint</Text>
        <SessionBackgroundHint onBackgroundSession={() => undefined} isLoading={false} />
        <Text>below the hint</Text>
      </Box>,
    )
    await Bun.sleep(150)
    return app
  }

  test('draws nothing', async () => {
    const app = await mountHint()
    foregroundAgent(app)
    await Bun.sleep(100)
    const lines = app.screen().split('\n').map(line => line.trimEnd()).filter(Boolean)
    expect(lines).toEqual(['above the hint', 'below the hint'])
  }, TIMEOUT)

  test('Ctrl+B sends every foreground task to the background and records that the user has done it', async () => {
    const app = await mountHint()
    const first = foregroundAgent(app, 'helper')
    const second = foregroundAgent(app, 'reviewer')
    await Bun.sleep(100)
    expect(getGlobalConfig().hasUsedBackgroundTask).toBeFalsy()
    await app.press(KEYS.ctrlB)
    for (const task of [first, second]) {
      expect(isBackgrounded(app.state(), task.taskId)).toBe(true)
      expect(task.signalled()).toBe(true)
    }
    expect(getGlobalConfig().hasUsedBackgroundTask).toBe(true)
  }, TIMEOUT)

  test('with the record already there, Ctrl+B keeps it', async () => {
    saveGlobalConfig(config => ({ ...config, hasUsedBackgroundTask: true }))
    const app = await mountHint()
    const task = foregroundAgent(app)
    await Bun.sleep(100)
    await app.press(KEYS.ctrlB)
    expect(isBackgrounded(app.state(), task.taskId)).toBe(true)
    expect(getGlobalConfig().hasUsedBackgroundTask).toBe(true)
  }, TIMEOUT)

  const inert = [
    {
      name: 'CLAUDIN_DISABLE_BACKGROUND_TASKS set: Ctrl+B does nothing',
      arrange: () => {
        process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS = '1'
      },
    },
    { name: 'no foreground task: Ctrl+B does nothing', arrange: () => undefined, backgroundFirst: true },
  ]
  for (const { name, arrange, backgroundFirst } of inert) {
    test(name, async () => {
      arrange()
      const app = await mountHint()
      const task = foregroundAgent(app)
      if (backgroundFirst) patchTask(app, task.taskId, { isBackgrounded: true })
      await Bun.sleep(100)
      await app.press(KEYS.ctrlB)
      expect(isBackgrounded(app.state(), task.taskId)).toBe(Boolean(backgroundFirst))
      expect(task.signalled()).toBe(false)
      expect(getGlobalConfig().hasUsedBackgroundTask).toBeFalsy()
    }, TIMEOUT)
  }
})

describe('useSessionBackgrounding', () => {
  type Event = [string, unknown?]

  async function mountBackgrounding() {
    const events: Event[] = []
    let handle: (() => void) | undefined
    const props = {
      setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => {
        events.push(['setMessages', typeof messages === 'function' ? 'updater' : messages.map(m => m.uuid)])
      },
      setIsLoading: (loading: boolean) => {
        events.push(['setIsLoading', loading])
      },
      resetLoadingState: () => {
        events.push(['resetLoadingState'])
      },
      setAbortController: (controller: AbortController | null) => {
        events.push(['setAbortController', controller])
      },
      onBackgroundQuery: () => {
        events.push(['onBackgroundQuery'])
      },
    }
    function Host(): null {
      handle = useSessionBackgrounding(props).handleBackgroundSession
      return null
    }
    const app = await mountInApp(<Host />)
    await Bun.sleep(100)
    return {
      app,
      events,
      /** The events since the last call. */
      take: () => events.splice(0),
      background: async () => {
        handle!()
        await Bun.sleep(80)
      },
    }
  }

  async function settle(): Promise<void> {
    await Bun.sleep(80)
  }

  const message = (text: string) => createUserMessage({ content: text })

  test('with nothing foregrounded, Ctrl+B asks the caller to background the current query, and nothing else', async () => {
    const rig = await mountBackgrounding()
    rig.take()
    await rig.background()
    expect(rig.take()).toEqual([['onBackgroundQuery']])
  }, TIMEOUT)

  test('a running foregrounded agent: its messages, loading state and abort controller reach the main view', async () => {
    const rig = await mountBackgrounding()
    const { taskId } = foregroundAgent(rig.app)
    const first = [message('one'), message('two')]
    patchTask(rig.app, taskId, { messages: first })
    rig.take()
    rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
    await settle()
    const controller = (rig.app.state().tasks[taskId] as { abortController?: AbortController }).abortController
    expect(controller).toBeInstanceOf(AbortController)
    expect(rig.take()).toEqual([
      ['setMessages', first.map(m => m.uuid)],
      ['setIsLoading', true],
      ['setAbortController', controller],
    ])

    // A new message is mirrored; a change that keeps the count is not.
    const third = message('three')
    patchTask(rig.app, taskId, { messages: [...first, third] })
    await settle()
    expect(rig.take().filter(([name]) => name === 'setMessages')).toEqual([
      ['setMessages', [...first, third].map(m => m.uuid)],
    ])
    patchTask(rig.app, taskId, { messages: [...first, message('replaced')] })
    await settle()
    expect(rig.take().filter(([name]) => name === 'setMessages')).toEqual([])
  }, TIMEOUT)

  test('a foregrounded agent with no messages yet sends an empty view only once there is something to show', async () => {
    const rig = await mountBackgrounding()
    const { taskId } = foregroundAgent(rig.app)
    rig.take()
    rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
    await settle()
    expect(rig.take().map(([name]) => name)).toEqual(['setIsLoading', 'setAbortController'])
  }, TIMEOUT)

  test('Ctrl+B with an agent foregrounded sends it back and clears the main view, without touching the query', async () => {
    const rig = await mountBackgrounding()
    const { taskId } = foregroundAgent(rig.app)
    const working = message('working')
    patchTask(rig.app, taskId, { messages: [working] })
    rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
    await settle()
    rig.take()
    await rig.background()
    expect(rig.app.state().foregroundedTaskId).toBeUndefined()
    expect(isBackgrounded(rig.app.state(), taskId)).toBe(true)
    expect(rig.take()).toEqual([['setMessages', []], ['resetLoadingState'], ['setAbortController', null]])

    // Brought forward again, its messages are sent afresh.
    rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
    await settle()
    expect(rig.take()[0]).toEqual(['setMessages', [working.uuid]])
  }, TIMEOUT)

  const endings = [
    { name: 'completes', end: (app: Picker, taskId: string) => patchTask(app, taskId, { status: 'completed' }) },
    { name: 'fails', end: (app: Picker, taskId: string) => patchTask(app, taskId, { status: 'failed' }) },
    {
      name: 'is aborted',
      end: (app: Picker, taskId: string) =>
        (app.state().tasks[taskId] as { abortController: AbortController }).abortController.abort(),
      // Aborting changes no state by itself; the next change to the task is what the hook sees.
      nudge: true,
    },
  ]
  for (const { name, end, nudge } of endings) {
    test(`a foregrounded agent that ${name} goes back to the background and the main view is released`, async () => {
      const rig = await mountBackgrounding()
      const { taskId } = foregroundAgent(rig.app)
      patchTask(rig.app, taskId, { messages: [message('working')] })
      rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
      await settle()
      rig.take()
      end(rig.app, taskId)
      if (nudge) patchTask(rig.app, taskId, { description: 'nudged' })
      await settle()
      expect(rig.app.state().foregroundedTaskId).toBeUndefined()
      expect(isBackgrounded(rig.app.state(), taskId)).toBe(true)
      expect(rig.take()).toEqual([['resetLoadingState'], ['setAbortController', null]])

      // Foregrounded again later, its messages are sent afresh.
      patchTask(rig.app, taskId, { status: 'running', abortController: new AbortController() })
      rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
      await settle()
      expect(rig.take()[0]).toEqual(['setMessages', [expect.any(String)]])
    }, TIMEOUT)
  }

  const strays = [
    { name: 'a task that does not exist', target: () => 'missing-task' },
    { name: 'a task that is not an agent', target: (app: Picker) => strayShellTask(app) },
  ]
  for (const { name, target } of strays) {
    test(`foregrounding ${name} is undone at once`, async () => {
      const rig = await mountBackgrounding()
      const taskId = target(rig.app)
      rig.take()
      rig.app.setState(prev => ({ ...prev, foregroundedTaskId: taskId }))
      await settle()
      expect(rig.app.state().foregroundedTaskId).toBeUndefined()
      expect(rig.take()).toEqual([['resetLoadingState']])
    }, TIMEOUT)
  }
})

/** A finished shell task in the store, as a stand-in for any task that is not an agent. */
function strayShellTask(app: Picker): string {
  const taskId = `b${randomUUID().slice(0, 8)}`
  app.setState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [taskId]: {
        id: taskId,
        type: 'local_bash',
        status: 'completed',
        description: 'ls',
        command: 'ls',
        isBackgrounded: true,
        startTime: Date.now(),
        outputFile: join(world.sandbox.root, 'out.txt'),
        outputOffset: 0,
        notified: true,
      } as never,
    },
  }))
  return taskId
}

describe('useFileHistorySnapshotInit', () => {
  type Seen = FileHistoryState[]

  async function mountInit(snapshots: FileHistorySnapshot[] | undefined) {
    const seen: Seen = []
    let rerender: (next: { snapshots?: FileHistorySnapshot[]; tick?: number }) => void = () => undefined
    const onUpdateState = (state: FileHistoryState) => {
      seen.push(state)
    }
    function Host(): null {
      const [input, setInput] = React.useState<{ snapshots?: FileHistorySnapshot[]; tick: number }>({ snapshots, tick: 0 })
      rerender = next => setInput(prev => ({ snapshots: next.snapshots ?? prev.snapshots, tick: prev.tick + 1 }))
      const fileHistoryState = React.useMemo<FileHistoryState>(
        () => ({ snapshots: [], trackedFiles: new Set(), snapshotSequence: input.tick }),
        [input.tick],
      )
      useFileHistorySnapshotInit(input.snapshots, fileHistoryState, onUpdateState)
      return null
    }
    await mountInApp(<Host />)
    await Bun.sleep(80)
    return {
      seen,
      rerender: async (next: { snapshots?: FileHistorySnapshot[] } = {}) => {
        rerender(next)
        await Bun.sleep(80)
      },
    }
  }

  async function resumedSnapshots(): Promise<{ snapshots: FileHistorySnapshot[]; tracked: string }> {
    const tracked = join(world.sandbox.projectDir, 'src', 'parser.ts')
    await writeSession({ trackedFiles: [tracked] })
    const { fileHistorySnapshots } = await loadLatest()
    if (!fileHistorySnapshots?.length) throw new Error('the resumed session carried no snapshots')
    return { snapshots: fileHistorySnapshots, tracked }
  }

  test("hands over, once, the state rebuilt from the resumed session's snapshots", async () => {
    const { snapshots, tracked } = await resumedSnapshots()
    const rig = await mountInit(snapshots)
    expect(rig.seen).toHaveLength(1)
    const [state] = rig.seen
    const shortPath = relative(world.sandbox.projectDir, tracked)
    expect(state!.snapshotSequence).toBe(1)
    expect([...state!.trackedFiles]).toEqual([shortPath])
    expect(state!.snapshots.map(s => Object.keys(s.trackedFileBackups))).toEqual([[shortPath]])
    expect(state!.snapshots[0]!.messageId).toBe(snapshots[0]!.messageId)
    expect(state!.snapshots[0]!.trackedFileBackups[shortPath]).toEqual(snapshots[0]!.trackedFileBackups[tracked]!)

    await rig.rerender()
    await rig.rerender({ snapshots })
    expect(rig.seen).toHaveLength(1)
  }, TIMEOUT)

  test('with checkpointing turned off, hands over nothing', async () => {
    const { snapshots } = await resumedSnapshots()
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    const rig = await mountInit(snapshots)
    await rig.rerender()
    expect(rig.seen).toEqual([])
  }, TIMEOUT)

  test('turned on later, it hands over the state at the next change', async () => {
    const { snapshots } = await resumedSnapshots()
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    const rig = await mountInit(snapshots)
    expect(rig.seen).toEqual([])
    delete process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING
    await rig.rerender()
    expect(rig.seen).toHaveLength(1)
  }, TIMEOUT)

  test('a session without snapshots hands over nothing, then or later', async () => {
    const { snapshots } = await resumedSnapshots()
    const rig = await mountInit(undefined)
    await rig.rerender({ snapshots })
    expect(rig.seen).toEqual([])
  }, TIMEOUT)

  test('an empty snapshot list hands over an empty state', async () => {
    const rig = await mountInit([])
    expect(rig.seen.map(state => ({ ...state, trackedFiles: [...state.trackedFiles] }))).toEqual([
      { snapshots: [], trackedFiles: [], snapshotSequence: 0 },
    ])
  }, TIMEOUT)
})
