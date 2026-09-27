import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as terminalMod from 'src/terminal/ink/terminal.js'
import * as configMod from 'src/platform/config/config.js'

// Snapshot the real exports BEFORE mock.module() runs. `import * as` namespaces
// are live, so restoring to the namespace itself would just re-apply the stub.
const realConfig = { ...configMod }
const realTerminal = { ...terminalMod }

// Mock at boundaries only: the config source and the terminal probe that can't
// be driven from env.
let mockYankBug = false
let mockConfig: { renderFrameRate?: string } = {}

mock.module('src/platform/config/config.js', () => ({
  ...configMod,
  getGlobalConfig: () => mockConfig as ReturnType<typeof configMod.getGlobalConfig>,
}))
mock.module('src/terminal/ink/terminal.js', () => ({
  ...terminalMod,
  hasCursorUpViewportYankBug: () => mockYankBug,
}))

const {
  getEffectiveFrameRate,
  isFrameRateForcedByEnv,
  resolveFrameIntervalMs,
} = await import('src/terminal/render/renderCadence.js')

const ENV_KEYS = [
  'CLAUDIN_FPS',
  'CLAUDIN_NO_FLICKER',
  'TERM_PROGRAM',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  mockYankBug = false
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
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/terminal/ink/terminal.js', () => realTerminal)
  mock.module('src/terminal/ink/terminal.js', () => realTerminal)
})

describe('resolveFrameIntervalMs — precedence order', () => {
  test('CLAUDIN_FPS wins over the yank bug, the config and the terminal', () => {
    process.env.CLAUDIN_FPS = '240'
    mockYankBug = true
    mockConfig = { renderFrameRate: '120' }
    process.env.TERM_PROGRAM = 'Apple_Terminal'
    expect(resolveFrameIntervalMs()).toBe(4)
  })

  test('the yank bug wins over the config', () => {
    mockYankBug = true
    mockConfig = { renderFrameRate: '360' }
    expect(resolveFrameIntervalMs()).toBe(16)
  })

  test.each([
    ['60', 16],
    ['120', 8],
    ['240', 4],
    ['360', 3],
  ])('an explicit config rate of %s resolves to %ims', (rate, intervalMs) => {
    mockConfig = { renderFrameRate: rate }
    expect(resolveFrameIntervalMs()).toBe(intervalMs)
  })

  // Ghostty was on the GPU list that made auto pick 120fps; auto is 60fps on
  // every terminal now, that one included.
  test.each(['ghostty', 'Apple_Terminal'])('auto is 60fps on %s', termProgram => {
    process.env.TERM_PROGRAM = termProgram
    expect(resolveFrameIntervalMs()).toBe(16)
  })

  test("an explicit 'auto' behaves like an unset config", () => {
    mockConfig = { renderFrameRate: 'auto' }
    process.env.TERM_PROGRAM = 'ghostty'
    expect(resolveFrameIntervalMs()).toBe(16)
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
      mockConfig = { renderFrameRate: '240' }
      expect(resolveFrameIntervalMs()).toBe(4)
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
    expect(getEffectiveFrameRate()).toBe('60')
  })

  test('falls back to the real rate for an off-ladder interval', () => {
    process.env.CLAUDIN_FPS = '90' // 11ms → 91fps
    expect(getEffectiveFrameRate()).toBe('91')
  })
})

describe('inline and fullscreen share one cadence', () => {
  // The spinner asks the clock for every tick, so this resolver is the single
  // source of the animation rate. A per-mode branch reappearing here is exactly
  // the regression this pins.
  test.each(['ghostty', 'Apple_Terminal'])(
    'CLAUDIN_NO_FLICKER does not change the interval on %s',
    termProgram => {
      process.env.TERM_PROGRAM = termProgram
      process.env.CLAUDIN_NO_FLICKER = '0'
      const inline = resolveFrameIntervalMs()
      process.env.CLAUDIN_NO_FLICKER = '1'
      expect(resolveFrameIntervalMs()).toBe(inline)
    },
  )
})
