import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { isStdinWatchdogEnabled, StdinWatchdog } from 'src/terminal/ink/stdinWatchdog.js'

type FakeStdin = {
  isTTY: boolean
  destroyed: boolean
  readableLength: number
  paused: boolean
  isPaused: () => boolean
  listeners: (event: string) => Array<() => void>
  addListener: (event: string, fn: () => void) => FakeStdin
  removeListener: (event: string, fn: () => void) => FakeStdin
}

function makeStdin(initial: { listener?: () => void } = {}): FakeStdin {
  const listenersMap = new Map<string, Array<() => void>>()
  if (initial.listener) {
    listenersMap.set('readable', [initial.listener])
  }
  const stdin: FakeStdin = {
    isTTY: true,
    destroyed: false,
    readableLength: 0,
    paused: false,
    isPaused() {
      return this.paused
    },
    listeners(event: string) {
      return listenersMap.get(event) ?? []
    },
    addListener(event: string, fn: () => void) {
      const arr = listenersMap.get(event) ?? []
      arr.push(fn)
      listenersMap.set(event, arr)
      return stdin
    },
    removeListener(event: string, fn: () => void) {
      const arr = listenersMap.get(event) ?? []
      listenersMap.set(
        event,
        arr.filter(x => x !== fn),
      )
      return stdin
    },
  }
  return stdin
}

function asStdin(s: FakeStdin): NodeJS.ReadStream {
  return s as unknown as NodeJS.ReadStream
}

describe('StdinWatchdog', () => {
  const originalEnv = process.env.CLAUDIN_STDIN_WATCHDOG

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDIN_STDIN_WATCHDOG
    } else {
      process.env.CLAUDIN_STDIN_WATCHDOG = originalEnv
    }
  })

  test('is enabled by default', () => {
    delete process.env.CLAUDIN_STDIN_WATCHDOG
    expect(isStdinWatchdogEnabled()).toBe(true)
  })

  test('respects opt-out env values', () => {
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.CLAUDIN_STDIN_WATCHDOG = off
      expect(isStdinWatchdogEnabled()).toBe(false)
    }
  })

  test('does nothing when not active', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => false,
      now: () => 1_000_000,
      staleThresholdMs: 100,
      checkIntervalMs: 1000,
    })
    expect(w.checkOnce()).toBe(false)
    expect(stdin.listeners('readable')).toEqual([listener])
  })

  test('does nothing when gap is below threshold', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 950,
      isActive: () => true,
      now: () => 1000,
      staleThresholdMs: 100,
      checkIntervalMs: 1000,
    })
    expect(w.checkOnce()).toBe(false)
  })

  test('re-attaches listener after stale gap (the wedge cure)', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    let recoveredGap = -1
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
      checkIntervalMs: 10_000,
      onRecover: gap => {
        recoveredGap = gap
      },
    })
    expect(w.checkOnce()).toBe(true)
    expect(stdin.listeners('readable')).toEqual([listener])
    expect(recoveredGap).toBe(60_000)
  })

  test('skips when listener was already removed by something else', () => {
    const listener = () => {}
    const stdin = makeStdin() // no listener registered
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    expect(w.checkOnce()).toBe(false)
    expect(stdin.listeners('readable')).toEqual([])
  })

  test('skips when stdin has buffered data (not actually wedged)', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    stdin.readableLength = 5
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    expect(w.checkOnce()).toBe(false)
  })

  test('skips when stdin is paused', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    stdin.paused = true
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    expect(w.checkOnce()).toBe(false)
  })

  test('skips when stdin is destroyed', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    stdin.destroyed = true
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    expect(w.checkOnce()).toBe(false)
  })

  test('preserves listener identity (same reference before and after)', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    expect(w.checkOnce()).toBe(true)
    const after = stdin.listeners('readable')
    expect(after).toHaveLength(1)
    expect(after[0]).toBe(listener)
  })
})

describe('StdinWatchdog start/stop', () => {
  let originalSetInterval: typeof setInterval
  let originalClearInterval: typeof clearInterval
  let intervalCb: (() => void) | null = null
  let intervalCleared = false

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval
    originalClearInterval = globalThis.clearInterval
    intervalCb = null
    intervalCleared = false
    globalThis.setInterval = ((cb: () => void) => {
      intervalCb = cb
      return { unref() {} } as unknown as NodeJS.Timeout
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (() => {
      intervalCleared = true
    }) as unknown as typeof clearInterval
  })

  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  })

  test('start schedules an interval and stop cancels it', () => {
    const listener = () => {}
    const stdin = makeStdin({ listener })
    const w = new StdinWatchdog({
      stdin: asStdin(stdin),
      listener,
      getLastStdinTime: () => 0,
      isActive: () => true,
      now: () => 60_000,
      staleThresholdMs: 30_000,
    })
    w.start()
    expect(intervalCb).not.toBeNull()
    // Invoking the scheduled callback should perform the cure once.
    intervalCb?.()
    expect(stdin.listeners('readable')).toEqual([listener])
    w.stop()
    expect(intervalCleared).toBe(true)
  })
})
