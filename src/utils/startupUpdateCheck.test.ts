import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  getEarlySkipReason,
  isCrossMajor,
  runStartupUpdateCheck,
} from 'src/utils/startupUpdateCheck.js'

describe('getEarlySkipReason', () => {
  const originalEnv = { ...process.env }
  const originalIsTTY = process.stdout.isTTY
  const originalArgv1 = process.argv[1]

  beforeEach(() => {
    delete process.env.CLAUDIN_SKIP_STARTUP_UPDATE
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })
    process.argv[1] = '/usr/local/bin/claudin'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    })
    process.argv[1] = originalArgv1
  })

  test('returns null when nothing triggers a skip', () => {
    expect(getEarlySkipReason([])).toBeNull()
  })

  test('skips when CLAUDIN_SKIP_STARTUP_UPDATE=1', () => {
    process.env.CLAUDIN_SKIP_STARTUP_UPDATE = '1'
    expect(getEarlySkipReason([])).toBe('env-skip')
  })

  test('skips when stdout is not a TTY (pipe / CI)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    })
    expect(getEarlySkipReason([])).toBe('not-tty')
  })

  test('skips for the update subcommand', () => {
    expect(getEarlySkipReason(['update'])).toBe('subcommand')
  })

  test('skips for the upgrade subcommand', () => {
    expect(getEarlySkipReason(['upgrade'])).toBe('subcommand')
  })

  test('skips for the doctor subcommand', () => {
    expect(getEarlySkipReason(['doctor'])).toBe('subcommand')
  })

  test('skips for --help / -h', () => {
    expect(getEarlySkipReason(['--help'])).toBe('flag')
    expect(getEarlySkipReason(['-h'])).toBe('flag')
  })

  test('skips for --version variants', () => {
    expect(getEarlySkipReason(['--version'])).toBe('flag')
    expect(getEarlySkipReason(['-v'])).toBe('flag')
    expect(getEarlySkipReason(['-V'])).toBe('flag')
  })

  test('skips when invoked via npx (_npx in path)', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc123/node_modules/@claudiolabs/claudin/bin/claudin'
    expect(getEarlySkipReason([])).toBe('npx')
  })

  test('does not skip for unrelated arbitrary arguments', () => {
    expect(getEarlySkipReason(['--print', 'hello'])).toBeNull()
    expect(getEarlySkipReason(['-p'])).toBeNull()
  })

  test('does not treat subcommand word as skip when it is a flag value', () => {
    // `claudin -p "update"` — "update" is the value of -p, not a subcommand.
    // Strict positional check (argv[0] non-flag) prevents the false positive.
    expect(getEarlySkipReason(['-p', 'update'])).toBeNull()
  })

  test('skips only the first positional, not arbitrary positions', () => {
    expect(getEarlySkipReason(['update', '--flag'])).toBe('subcommand')
    expect(getEarlySkipReason(['mcp'])).toBe('subcommand')
  })

  test('priority: env-skip beats subcommand check', () => {
    process.env.CLAUDIN_SKIP_STARTUP_UPDATE = '1'
    expect(getEarlySkipReason(['update'])).toBe('env-skip')
  })
})

describe('isCrossMajor', () => {
  test('same major returns false', () => {
    expect(isCrossMajor('0.2.4', '0.2.5')).toBe(false)
    expect(isCrossMajor('0.2.4', '0.99.0')).toBe(false)
    expect(isCrossMajor('1.0.0', '1.10.3')).toBe(false)
  })

  test('different major returns true', () => {
    expect(isCrossMajor('0.2.4', '1.0.0')).toBe(true)
    expect(isCrossMajor('1.5.0', '2.0.0')).toBe(true)
    expect(isCrossMajor('1.0.0', '0.9.0')).toBe(true)
  })

  test('malformed versions return false (fail-open, no skip)', () => {
    expect(isCrossMajor('garbage', '1.0.0')).toBe(false)
    expect(isCrossMajor('1.0.0', '')).toBe(false)
  })
})

describe('runStartupUpdateCheck — fail-open behavior', () => {
  const originalEnv = { ...process.env }
  const originalIsTTY = process.stdout.isTTY

  beforeEach(() => {
    delete process.env.CLAUDIN_SKIP_STARTUP_UPDATE
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    })
  })

  test('returns silently when skip env is set', async () => {
    process.env.CLAUDIN_SKIP_STARTUP_UPDATE = '1'
    await expect(runStartupUpdateCheck(['update'])).resolves.toBeUndefined()
  })

  test('returns silently on a subcommand (e.g. update)', async () => {
    await expect(runStartupUpdateCheck(['update'])).resolves.toBeUndefined()
  })

  test('returns silently on --help', async () => {
    await expect(runStartupUpdateCheck(['--help'])).resolves.toBeUndefined()
  })

  test('returns silently on non-TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    })
    await expect(runStartupUpdateCheck([])).resolves.toBeUndefined()
  })

  test('never throws even when underlying modules fail (fail-open)', async () => {
    // No env to skip — exercises the lazy-import + outer catch.
    // In a test env this will hit getCurrentInstallationType() and likely
    // return 'development', so it exits cleanly via the install-type check.
    await expect(runStartupUpdateCheck([])).resolves.toBeUndefined()
  })
})
