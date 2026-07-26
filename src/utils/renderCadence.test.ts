import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as terminalMod from '../ink/terminal.js'
import * as configMod from './config.js'

// Snapshot the real exports BEFORE mock.module() runs. `import * as` namespaces
// are live, so restoring to the namespace itself would just re-apply the stub.
const realConfig = { ...configMod }
const realTerminal = { ...terminalMod }

// Mock at boundaries only: the config source and the two terminal probes that
// can't be driven from env. The GPU allowlist itself stays real — it is the
// thing under test.
let mockYankBug = false
let mockXtversion: string | undefined
let mockConfig: { renderFrameRate?: string } = {}

mock.module('./config.js', () => ({
  ...configMod,
  getGlobalConfig: () => mockConfig as ReturnType<typeof configMod.getGlobalConfig>,
}))
mock.module('../ink/terminal.js', () => ({
  ...terminalMod,
  hasCursorUpViewportYankBug: () => mockYankBug,
  getXtversionName: () => mockXtversion,
}))

const {
  getEffectiveFrameRate,
  isFrameRateForcedByEnv,
  isGpuTerminal,
  resolveFrameIntervalMs,
} = await import('./renderCadence.js')

const ENV_KEYS = [
  'CLAUDIN_FPS',
  'CLAUDE_CODE_NO_FLICKER',
  'TERM',
  'TERM_PROGRAM',
  'TMUX',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  mockYankBug = false
  mockXtversion = undefined
  mockConfig = {}
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

// Restore the reals so the partial config.js mock (getGlobalConfig returning a
// bare object) does not leak into later test files in the same run.
afterAll(() => {
  mock.module('./config.js', () => realConfig)
  mock.module('src/utils/config.js', () => realConfig)
  mock.module('../ink/terminal.js', () => realTerminal)
  mock.module('src/ink/terminal.js', () => realTerminal)
})

describe('resolveFrameIntervalMs — precedence order', () => {
  test('CLAUDIN_FPS wins over the yank bug, the config and the terminal', () => {
    process.env.CLAUDIN_FPS = '240'
    mockYankBug = true
    mockConfig = { renderFrameRate: '120' }
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(resolveFrameIntervalMs()).toBe(4)
  })

  test('the yank bug wins over the config and a GPU terminal', () => {
    mockYankBug = true
    mockConfig = { renderFrameRate: '360' }
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(16)
  })

  test('an explicit config rate wins over auto on a non-GPU terminal', () => {
    mockConfig = { renderFrameRate: '240' }
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(resolveFrameIntervalMs()).toBe(4)
  })

  test('an explicit config rate wins over the tmux cap', () => {
    mockConfig = { renderFrameRate: '240' }
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(4)
  })

  test('auto picks 120fps on a GPU terminal', () => {
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(8)
  })

  test('auto caps at 60fps under tmux even on a GPU terminal', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(16)
  })

  test('auto falls back to 60fps off a GPU terminal', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(resolveFrameIntervalMs()).toBe(16)
  })

  test("an explicit 'auto' behaves like an unset config", () => {
    mockConfig = { renderFrameRate: 'auto' }
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(8)
  })
})

describe('resolveFrameIntervalMs — rate mapping', () => {
  test.each([
    ['60', 16],
    ['120', 8],
    ['240', 4],
    ['360', 3],
  ])('CLAUDIN_FPS=%s resolves to %ims', (fps, intervalMs) => {
    process.env.CLAUDIN_FPS = fps
    expect(resolveFrameIntervalMs()).toBe(intervalMs)
  })

  test.each(['0', '-1', '9', '361', '999', 'abc', ''])(
    'CLAUDIN_FPS=%p is ignored and resolution falls through',
    fps => {
      process.env.CLAUDIN_FPS = fps
      process.env.TERM_PROGRAM = 'ghostty'
      expect(resolveFrameIntervalMs()).toBe(8)
      expect(isFrameRateForcedByEnv()).toBe(false)
    },
  )

  test('a valid CLAUDIN_FPS pins the /config row', () => {
    process.env.CLAUDIN_FPS = '240'
    expect(isFrameRateForcedByEnv()).toBe(true)
  })
})

describe('getEffectiveFrameRate', () => {
  test('reports the nominal rung, not the delivered rate', () => {
    process.env.CLAUDIN_FPS = '240'
    // 1000/240 truncates to 4ms, which delivers 250fps — the label still says
    // what the user picked.
    expect(getEffectiveFrameRate()).toBe('240')
  })

  test('reports what auto resolved to', () => {
    process.env.TERM_PROGRAM = 'ghostty'
    expect(getEffectiveFrameRate()).toBe('120')
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(getEffectiveFrameRate()).toBe('60')
  })

  test('falls back to the real rate for an off-ladder interval', () => {
    process.env.CLAUDIN_FPS = '90' // 11ms → 91fps
    expect(getEffectiveFrameRate()).toBe('91')
  })
})

describe('isGpuTerminal', () => {
  test.each([
    'ghostty',
    'kitty',
    'WezTerm',
    'alacritty',
    'contour',
    'foot',
    'rio',
    'WarpTerminal',
  ])('accepts TERM_PROGRAM=%s', termProgram => {
    process.env.TERM_PROGRAM = termProgram
    expect(isGpuTerminal()).toBe(true)
  })

  test.each(['xterm-kitty', 'xterm-ghostty', 'alacritty', 'foot-extra'])(
    'accepts TERM=%s when TERM_PROGRAM is absent',
    term => {
      process.env.TERM = term
      expect(isGpuTerminal()).toBe(true)
    },
  )

  test('accepts a GPU terminal announced over XTVERSION (survives SSH)', () => {
    process.env.TERM = 'xterm-256color'
    mockXtversion = 'Ghostty 1.0.1'
    expect(isGpuTerminal()).toBe(true)
  })

  test.each(['Apple_Terminal', 'iTerm.app', 'vscode', 'Generic_Terminal'])(
    'rejects TERM_PROGRAM=%s',
    termProgram => {
      process.env.TERM_PROGRAM = termProgram
      process.env.TERM = 'xterm-256color'
      expect(isGpuTerminal()).toBe(false)
    },
  )

  test('rejects an xterm.js XTVERSION reply', () => {
    mockXtversion = 'xterm.js 5.3.0'
    expect(isGpuTerminal()).toBe(false)
  })

  test('rejects a bare terminal with nothing to go on', () => {
    expect(isGpuTerminal()).toBe(false)
  })
})

describe('inline and fullscreen share one cadence', () => {
  // The spinner asks the clock for every tick, so this resolver is the single
  // source of the animation rate. A per-mode branch reappearing here is exactly
  // the regression this pins.
  test.each(['ghostty', 'Apple_Terminal'])(
    'CLAUDE_CODE_NO_FLICKER does not change the interval on %s',
    termProgram => {
      process.env.TERM_PROGRAM = termProgram
      process.env.CLAUDE_CODE_NO_FLICKER = '0'
      const inline = resolveFrameIntervalMs()
      process.env.CLAUDE_CODE_NO_FLICKER = '1'
      expect(resolveFrameIntervalMs()).toBe(inline)
    },
  )
})
