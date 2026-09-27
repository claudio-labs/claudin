import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as configMod from 'src/platform/config/config.js'
import * as terminalMod from 'src/terminal/ink/terminal.js'

// Snapshot the real exports BEFORE mock.module() runs. `import * as` namespaces
// are live: Bun rewrites configMod.getGlobalConfig to the stub once the mock is
// registered, so restoring to `configMod` itself would just re-apply the stub.
// A plain-object copy taken here preserves the genuine functions for teardown.
const realConfig = { ...configMod }
const realTerminal = { ...terminalMod }

// Mock at boundaries: config source and the terminal-identity probe.
// Spread the real modules so other consumers' exports stay intact (the rest
// of the test process imports config.js too).
let mockRewrite = false
let mockConfig: { flickerFreeMode?: boolean } = {}

mock.module('src/platform/config/config.js', () => ({
  ...configMod,
  getGlobalConfig: () => mockConfig as ReturnType<typeof configMod.getGlobalConfig>,
}))
mock.module('src/terminal/ink/terminal.js', () => ({
  ...terminalMod,
  shouldUseMainScreenRewrite: () => mockRewrite,
}))

const {
  acquireFullscreenLease,
  canLeaseFullscreen,
  isFullscreenEnvEnabled,
  isTemporaryFullscreen,
  subscribeFullscreenLease,
  _resetFullscreenLeasesForTesting,
  _resetTmuxControlModeProbeForTesting,
} = await import('src/terminal/render/fullscreen.js')
const { getIsInteractive, setIsInteractive } = await import(
  'src/platform/bootstrap/state.js'
)

const ENV_KEYS = [
  'CLAUDIN_NO_FLICKER',
  'CLAUDIN_TEMP_FULLSCREEN',
  'TMUX',
  'TERM_PROGRAM',
  'TERM',
] as const
const saved: Record<string, string | undefined> = {}
const savedInteractive = getIsInteractive()

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  mockRewrite = false
  mockConfig = {}
  _resetTmuxControlModeProbeForTesting()
  _resetFullscreenLeasesForTesting()
  setIsInteractive(true)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetTmuxControlModeProbeForTesting()
  _resetFullscreenLeasesForTesting()
  setIsInteractive(savedInteractive)
})

// Restore the real modules so the partial config.js mock (getGlobalConfig
// returning a bare { flickerFreeMode } object) does not leak into later test
// files in the same run — otherwise getGlobalConfig() loses every other flag
// (e.g. toolResultSummarizerEnabled) for the rest of the process.
afterAll(() => {
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/terminal/ink/terminal.js', () => realTerminal)
  mock.module('src/terminal/ink/terminal.js', () => realTerminal)
})

describe('isFullscreenEnvEnabled — precedence order', () => {
  test('env opt-out wins over everything', () => {
    process.env.CLAUDIN_NO_FLICKER = '0'
    mockConfig = { flickerFreeMode: true }
    mockRewrite = true
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('env opt-in wins over tmux -CC and config', () => {
    process.env.CLAUDIN_NO_FLICKER = '1'
    process.env.TMUX = '/tmp/tmux'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    mockConfig = { flickerFreeMode: false }
    expect(isFullscreenEnvEnabled()).toBe(true)
  })

  test('tmux -CC disables when env is unset', () => {
    process.env.TMUX = '/tmp/tmux'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    mockConfig = { flickerFreeMode: true } // would otherwise enable
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('explicit config=true enables when env unset and not tmux -CC', () => {
    mockConfig = { flickerFreeMode: true }
    expect(isFullscreenEnvEnabled()).toBe(true)
  })

  test('explicit config=false disables even when rewrite path would enable', () => {
    mockConfig = { flickerFreeMode: false }
    mockRewrite = true
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('rewrite-path terminal defaults to on when nothing else is set', () => {
    mockRewrite = true
    expect(isFullscreenEnvEnabled()).toBe(true)
  })

  test('non-rewrite terminal defaults to off', () => {
    mockRewrite = false
    expect(isFullscreenEnvEnabled()).toBe(false)
  })
})

describe('fullscreen lease', () => {
  const setTmuxControlMode = (): void => {
    process.env.TMUX = '/tmp/tmux'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
  }

  test('an inline session is fullscreen while a lease is held, and inline after', () => {
    mockConfig = { flickerFreeMode: false }
    const release = acquireFullscreenLease()
    expect(isFullscreenEnvEnabled()).toBe(true)
    expect(isTemporaryFullscreen()).toBe(true)
    release()
    expect(isFullscreenEnvEnabled()).toBe(false)
    expect(isTemporaryFullscreen()).toBe(false)
  })

  test('a session already in fullscreen is never temporary', () => {
    mockConfig = { flickerFreeMode: true }
    acquireFullscreenLease()
    expect(isFullscreenEnvEnabled()).toBe(true)
    // Nothing to come back to: the main-screen preservation must not engage.
    expect(isTemporaryFullscreen()).toBe(false)
  })

  test('the env opt-out beats a lease', () => {
    process.env.CLAUDIN_NO_FLICKER = '0'
    acquireFullscreenLease()
    expect(canLeaseFullscreen()).toBe(false)
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('tmux -CC beats a lease', () => {
    setTmuxControlMode()
    acquireFullscreenLease()
    expect(canLeaseFullscreen()).toBe(false)
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('CLAUDIN_TEMP_FULLSCREEN=0 turns the lease off', () => {
    process.env.CLAUDIN_TEMP_FULLSCREEN = '0'
    acquireFullscreenLease()
    expect(canLeaseFullscreen()).toBe(false)
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('a non-interactive session cannot lease', () => {
    setIsInteractive(false)
    expect(canLeaseFullscreen()).toBe(false)
  })

  test('fullscreen stays on until the last holder releases', () => {
    const releaseDiff = acquireFullscreenLease()
    const releaseExplorer = acquireFullscreenLease()
    releaseDiff()
    expect(isFullscreenEnvEnabled()).toBe(true)
    releaseExplorer()
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('a release is idempotent and cannot free another holder', () => {
    const releaseDiff = acquireFullscreenLease()
    const releaseExplorer = acquireFullscreenLease()
    releaseDiff()
    releaseDiff()
    expect(isFullscreenEnvEnabled()).toBe(true)
    releaseExplorer()
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('subscribers hear the edges, not every holder', () => {
    let calls = 0
    subscribeFullscreenLease(() => {
      calls++
    })
    const a = acquireFullscreenLease()
    const b = acquireFullscreenLease()
    b()
    expect(calls).toBe(1)
    a()
    expect(calls).toBe(2)
  })
})
