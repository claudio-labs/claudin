import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as configMod from 'src/services/config/config.js'
import * as terminalMod from 'src/ink/terminal.js'

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

mock.module('src/services/config/config.js', () => ({
  ...configMod,
  getGlobalConfig: () => mockConfig as ReturnType<typeof configMod.getGlobalConfig>,
}))
mock.module('src/ink/terminal.js', () => ({
  ...terminalMod,
  shouldUseMainScreenRewrite: () => mockRewrite,
}))

const {
  isFullscreenEnvEnabled,
  _resetTmuxControlModeProbeForTesting,
} = await import('src/utils/fullscreen.js')

const ENV_KEYS = ['CLAUDE_CODE_NO_FLICKER', 'TMUX', 'TERM_PROGRAM', 'TERM'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  mockRewrite = false
  mockConfig = {}
  _resetTmuxControlModeProbeForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetTmuxControlModeProbeForTesting()
})

// Restore the real modules so the partial config.js mock (getGlobalConfig
// returning a bare { flickerFreeMode } object) does not leak into later test
// files in the same run — otherwise getGlobalConfig() loses every other flag
// (e.g. toolResultSummarizerEnabled) for the rest of the process.
afterAll(() => {
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/ink/terminal.js', () => realTerminal)
  mock.module('src/ink/terminal.js', () => realTerminal)
})

describe('isFullscreenEnvEnabled — precedence order', () => {
  test('env opt-out wins over everything', () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    mockConfig = { flickerFreeMode: true }
    mockRewrite = true
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('env opt-in wins over tmux -CC and config', () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
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
