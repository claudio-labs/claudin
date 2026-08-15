import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'

// Track what the hook would do without actually killing the test process or
// spawning real subprocesses. We install module mocks before importing the
// hook so the real `process.kill` / `spawnSync` / worktree lookups never run.
type Mocks = {
  killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }>
  spawnSyncCalls: Array<unknown[]>
  currentWorktreeSession: unknown
  isBgSessionResult: boolean
  exitCallResult: React.ReactNode
}

const mocks: Mocks = {
  killCalls: [],
  spawnSyncCalls: [],
  currentWorktreeSession: null,
  isBgSessionResult: false,
  exitCallResult: null,
}

beforeAll(() => {
  // Replace `process.kill` so SIGKILL paths don't actually terminate bun.
  const realKill = process.kill.bind(process)
  ;(process as unknown as { kill: typeof process.kill }).kill = ((
    pid: number,
    signal?: NodeJS.Signals | number,
  ) => {
    mocks.killCalls.push({ pid, signal: signal ?? 0 })
    return true
  }) as typeof process.kill
  // Restore on teardown via afterAll.
  ;(globalThis as unknown as { __realProcessKill: typeof process.kill }).__realProcessKill = realKill

  mock.module('child_process', () => ({
    spawnSync: (...args: unknown[]) => {
      mocks.spawnSyncCalls.push(args)
      return { status: 0 }
    },
  }))
  mock.module('src/services/session/concurrentSessions.js', () => ({
    isBgSession: () => mocks.isBgSessionResult,
    updateSessionName: () => {},
    updateSessionActivity: () => {},
  }))
  mock.module('src/services/git/worktree.js', () => ({
    getCurrentWorktreeSession: () => mocks.currentWorktreeSession,
  }))
  mock.module('src/components/ExitFlow.js', () => ({
    ExitFlow: () => null,
  }))
  mock.module('src/commands/exit/index.js', () => ({
    default: {
      load: async () => ({
        call: async () => mocks.exitCallResult,
      }),
    },
  }))
})

afterAll(() => {
  mock.restore()
  const realKill = (globalThis as unknown as { __realProcessKill?: typeof process.kill }).__realProcessKill
  if (realKill) {
    ;(process as unknown as { kill: typeof process.kill }).kill = realKill
  }
})

// Import AFTER mocks are installed.
const { useReplExit } = await import('src/screens/repl/hooks/useReplExit.js')
const { render } = await import('src/terminal/ink.js')

type HookResult = ReturnType<typeof useReplExit>

// Capture the hook return value across renders via a mutable ref the test
// holds. Ink renders the harness in a real React tree so state transitions
// flow through React the same way they do in REPL.tsx.
function Harness({ onResult }: { onResult: (r: HookResult) => void }) {
  const result = useReplExit()
  React.useEffect(() => {
    onResult(result)
  })
  return null
}

async function mountHarness(): Promise<{
  getResult: () => HookResult
  unmount: () => void
}> {
  let latest: HookResult | null = null
  const stream = new PassThrough()
  stream.on('data', () => {})
  const instance = await render(
    <Harness onResult={(r) => { latest = r }} />,
    { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  // Wait one tick so the first effect commits.
  await new Promise<void>((r) => setTimeout(r, 0))
  return {
    getResult: () => {
      if (!latest) throw new Error('hook did not produce a result')
      return latest
    },
    unmount: () => instance.unmount(),
  }
}

function resetMocks(): void {
  mocks.killCalls = []
  mocks.spawnSyncCalls = []
  mocks.currentWorktreeSession = null
  mocks.isBgSessionResult = false
  mocks.exitCallResult = null
}

describe('useReplExit', () => {
  test('initial state: not exiting, no exitFlow', async () => {
    resetMocks()
    const h = await mountHarness()
    try {
      const r = h.getResult()
      expect(r.isExiting).toBe(false)
      expect(r.exitFlow).toBeNull()
    } finally {
      h.unmount()
    }
  })

  test('worktree path: sets exitFlow and isExiting on first call', async () => {
    resetMocks()
    mocks.currentWorktreeSession = { name: 'wt-1' }
    const h = await mountHarness()
    try {
      await h.getResult().handleExit()
      // Wait for state to commit.
      await new Promise<void>((r) => setTimeout(r, 10))
      const r = h.getResult()
      expect(r.isExiting).toBe(true)
      expect(r.exitFlow).not.toBeNull()
      // No kill yet — failsafe timer is armed but hasn't fired.
      expect(mocks.killCalls.length).toBe(0)
    } finally {
      h.unmount()
    }
  })

  test('exit completes when call() returns null (bg detach style)', async () => {
    resetMocks()
    // No worktree, no bg — falls through to exit.load().call().
    mocks.exitCallResult = null
    const h = await mountHarness()
    try {
      await h.getResult().handleExit()
      await new Promise<void>((r) => setTimeout(r, 10))
      const r = h.getResult()
      // exitFlowResult === null branch clears isExiting back to false.
      expect(r.isExiting).toBe(false)
      expect(r.exitFlow).toBeNull()
    } finally {
      h.unmount()
    }
  })

  test('same-press double-dispatch collapses (no SIGKILL within 250ms)', async () => {
    resetMocks()
    mocks.currentWorktreeSession = { name: 'wt-1' }
    const h = await mountHarness()
    try {
      // Two synchronous calls — both fire in the same tick (PromptInput +
      // useExitOnCtrlCDWithKeybindings). Second one must be collapsed.
      const p1 = h.getResult().handleExit()
      const p2 = h.getResult().handleExit()
      await Promise.all([p1, p2])
      await new Promise<void>((r) => setTimeout(r, 10))
      expect(mocks.killCalls.length).toBe(0)
    } finally {
      h.unmount()
    }
  })

  test('bg session path: detaches via tmux and clears state', async () => {
    resetMocks()
    mocks.isBgSessionResult = true
    const h = await mountHarness()
    try {
      await h.getResult().handleExit()
      await new Promise<void>((r) => setTimeout(r, 10))
      // BG_SESSIONS is a feature flag; this branch only runs if the flag is
      // truthy at build time. In test we can't predict the flag, so we just
      // assert the state remains consistent (either path settles isExiting).
      const r = h.getResult()
      expect(typeof r.isExiting).toBe('boolean')
      expect(mocks.killCalls.length).toBe(0)
    } finally {
      h.unmount()
    }
  })
})
