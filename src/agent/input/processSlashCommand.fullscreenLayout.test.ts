import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'

import {
  processUserInput,
  type ProcessUserInputContext,
} from 'src/agent/input/processUserInput.js'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import {
  _resetFullscreenLeasesForTesting,
  subscribeFullscreenLease,
} from 'src/terminal/render/fullscreen.js'
import {
  __resetToolJSXStoreForTests,
  dispatchToolJSX,
} from 'src/terminal/toolJSXStore.js'
import type { Command } from 'src/shared/types/command.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'

// A `fullscreenLayout` command takes a fullscreen lease for as long as its
// dialog is up. The lease is watched through its edges (0→1 held, 1→0
// released), which do not depend on the renderer the machine is configured
// for.

const ENV_KEYS = ['CLAUDIN_NO_FLICKER', 'CLAUDIN_TEMP_FULLSCREEN', 'TMUX'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedInteractive = getIsInteractive()

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  setIsInteractive(true)
  _resetFullscreenLeasesForTesting()
  __resetToolJSXStoreForTests()
})

afterEach(() => {
  _resetFullscreenLeasesForTesting()
  __resetToolJSXStoreForTests()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  setIsInteractive(savedInteractive)
})

type Harness = {
  command: Command
  called: Promise<void>
  onDone: () => ((result?: string) => void) | undefined
}

function fullscreenLayoutCommand(beforeReturn: () => void = () => {}): Harness {
  let onDone: ((result?: string) => void) | undefined
  let markCalled: () => void = () => {}
  const called = new Promise<void>(resolve => {
    markCalled = resolve
  })
  const command = {
    type: 'local-jsx',
    name: 'layout-probe',
    description: 'probe',
    fullscreenLayout: true,
    load: async () => ({
      call: async (done: (result?: string) => void) => {
        onDone = done
        beforeReturn()
        markCalled()
        return 'dialog'
      },
    }),
  } as unknown as Command
  return { command, called, onDone: () => onDone }
}

function makeContext(commands: Command[]): ProcessUserInputContext {
  return {
    agentId: undefined,
    options: {
      tools: [],
      commands,
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
      isNonInteractiveSession: false,
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { commands: [] },
      sessionHooks: new Map(),
    }),
    setAppState: () => {},
    readFileState: new Map(),
    abortController: new AbortController(),
  } as unknown as ProcessUserInputContext
}

function watchLease(): { held: () => boolean } {
  let held = false
  subscribeFullscreenLease(() => {
    held = !held
  })
  return { held: () => held }
}

/** Let the `.then(jsx => …)` that sets the dialog run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

type SetArgs = {
  isLocalJSXCommand?: boolean
  generation?: number
  fullscreenLease?: () => void
}

test('the lease is taken in the tick the dialog is set and rides it to the store', async () => {
  const lease = watchLease()
  const harness = fullscreenLayoutCommand()
  const setCalls: { held: boolean; args: SetArgs }[] = []
  const pending = processUserInput({
    input: '/layout-probe',
    mode: 'prompt',
    setToolJSX: ((args: SetArgs) => {
      setCalls.push({ held: lease.held(), args })
    }) as never,
    context: makeContext([harness.command]),
  })
  await harness.called
  await settle()

  // The first frame of the dialog is already the fullscreen one.
  expect(setCalls[0]?.held).toBe(true)
  const release = setCalls[0]?.args.fullscreenLease
  expect(typeof release).toBe('function')

  // onDone does not hand it back: the store does, when the dialog is cleared,
  // so no render in between draws the dialog inline.
  harness.onDone()?.('Probe dismissed')
  await pending
  expect(lease.held()).toBe(true)
  release?.()
  expect(lease.held()).toBe(false)
})

test('a dialog a clear already superseded hands its lease straight back', async () => {
  const lease = watchLease()
  // A clear between the capture of the generation and the write: the store
  // drops the write, the dialog never shows, and onDone never comes.
  const harness = fullscreenLayoutCommand(() => {
    dispatchToolJSX({ type: 'clear_local_jsx' })
  })
  void processUserInput({
    input: '/layout-probe',
    mode: 'prompt',
    // What REPL's setToolJSX does with a local-jsx write.
    setToolJSX: ((args: SetArgs) => {
      dispatchToolJSX(
        {
          type: 'set_local_jsx',
          payload: args as never,
          generation: args.generation ?? Number.MAX_SAFE_INTEGER,
        },
        args.fullscreenLease,
      )
    }) as never,
    context: makeContext([harness.command]),
  })
  await harness.called
  await settle()
  expect(lease.held()).toBe(false)
})

test('a command not drawn for the fullscreen layout takes no lease', async () => {
  const lease = watchLease()
  const harness = fullscreenLayoutCommand()
  ;(harness.command as { fullscreenLayout?: boolean }).fullscreenLayout = undefined
  const setCalls: SetArgs[] = []
  void processUserInput({
    input: '/layout-probe',
    mode: 'prompt',
    setToolJSX: ((args: SetArgs) => {
      setCalls.push(args)
    }) as never,
    context: makeContext([harness.command]),
  })
  await harness.called
  await settle()
  expect(lease.held()).toBe(false)
  expect(setCalls[0]?.fullscreenLease).toBeUndefined()
})
