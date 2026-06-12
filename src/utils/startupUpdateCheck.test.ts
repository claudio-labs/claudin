import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetForceCheckWarnedForTesting,
  getEarlySkipReason,
  isCrossMajor,
  runStartupUpdateCheck,
  THROTTLE_MS,
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

describe('runStartupUpdateCheck — gates, throttle, and CLAUDIN_FORCE_UPDATE_CHECK', () => {
  const originalEnv = { ...process.env }
  const originalIsTTY = process.stdout.isTTY
  const originalConsoleError = console.error
  let writeCalls: number
  let getLatestCalls: number
  let isAutoUpdaterDisabledReturn: boolean
  let disabledReasonOptsSeen: unknown[]
  let installTypeReturn: string
  let tmpDir: string
  let consoleErrorMessages: string[]

  // Real on-disk modules from the production codepath stay real so the test
  // exercises the throttle file format (last-update-check) authentically.
  // Only the network boundary, settings opt-out, install-type detection, and
  // the cache write are mocked.
  beforeEach(async () => {
    delete process.env.CLAUDIN_SKIP_STARTUP_UPDATE
    delete process.env.CLAUDIN_FORCE_UPDATE_CHECK
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })
    __resetForceCheckWarnedForTesting()
    writeCalls = 0
    getLatestCalls = 0
    isAutoUpdaterDisabledReturn = false
    disabledReasonOptsSeen = []
    installTypeReturn = 'native'
    consoleErrorMessages = []
    console.error = (msg: string) => {
      consoleErrorMessages.push(String(msg))
    }
    // Each test gets a fresh CLAUDIN_CONFIG_DIR so the throttle file
    // (`last-update-check`) and any incidental cache writes go to a
    // throwaway directory — never the dev's real ~/.claudin.
    tmpDir = await mkdtemp(join(tmpdir(), 'claudin-startup-update-check-'))
    process.env.CLAUDIN_CONFIG_DIR = tmpDir
    ;(globalThis as { MACRO?: { VERSION: string; DISPLAY_VERSION?: string } }).MACRO = {
      VERSION: '0.0.0',
      DISPLAY_VERSION: '0.0.1',
    }
    mock.module('src/utils/config.js', () => ({
      getAutoUpdaterDisabledReason: (opts?: unknown) => {
        disabledReasonOptsSeen.push(opts)
        return isAutoUpdaterDisabledReturn ? { type: 'config' } : null
      },
    }))
    mock.module('src/utils/doctorDiagnostic.js', () => ({
      getCurrentInstallationType: () => Promise.resolve(installTypeReturn),
    }))
    mock.module('src/utils/autoUpdater.js', () => ({
      getLatestVersion: () => {
        getLatestCalls += 1
        return Promise.resolve('99.99.99')
      },
    }))
    mock.module('src/utils/latestVersionCache.js', () => ({
      writeLatestVersion: () => {
        writeCalls += 1
        return Promise.resolve()
      },
    }))
    mock.module('src/utils/settings/settings.js', () => ({
      getInitialSettings: () => ({}),
    }))
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    })
    console.error = originalConsoleError
    // Restore module mocks so they don't bleed into sibling test files
    // sharing the same Bun process (Bun's mock.module is process-scoped).
    mock.restore()
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  test('force-flag bypasses getAutoUpdaterDisabledReason() and dev install gate', async () => {
    process.env.CLAUDIN_FORCE_UPDATE_CHECK = '1'
    isAutoUpdaterDisabledReturn = true
    installTypeReturn = 'development'
    await runStartupUpdateCheck([])
    expect(writeCalls).toBe(1)
  })

  test('force-flag emits a one-shot stderr warning (footgun guard)', async () => {
    process.env.CLAUDIN_FORCE_UPDATE_CHECK = '1'
    isAutoUpdaterDisabledReturn = true
    installTypeReturn = 'development'
    await runStartupUpdateCheck([])
    expect(
      consoleErrorMessages.some(m => m.includes('CLAUDIN_FORCE_UPDATE_CHECK=1')),
    ).toBe(true)
  })

  test('force-flag warning fires at most once per process across calls (kills "drop the guard" mutation)', async () => {
    // Without the `!forceCheckWarned` guard, every launch would re-emit
    // the warning. Asserting count===1 across two invocations is the only
    // way to catch a mutation that flips `forceCheckWarned = true` to
    // `forceCheckWarned = forceCheckWarned` or removes the assignment.
    process.env.CLAUDIN_FORCE_UPDATE_CHECK = '1'
    isAutoUpdaterDisabledReturn = true
    installTypeReturn = 'development'
    await runStartupUpdateCheck([])
    await runStartupUpdateCheck([])
    const forceMessages = consoleErrorMessages.filter(m =>
      m.includes('CLAUDIN_FORCE_UPDATE_CHECK=1 honored'),
    )
    expect(forceMessages.length).toBe(1)
  })

  test('without the flag, opt-out alone short-circuits before write', async () => {
    isAutoUpdaterDisabledReturn = true
    installTypeReturn = 'native'
    await runStartupUpdateCheck([])
    expect(writeCalls).toBe(0)
  })

  test('opt-out gate exempts the Claudin-default privacy level (regression: dead update notice)', async () => {
    // The startup version check must ask getAutoUpdaterDisabledReason to
    // ignore the *default* essential-traffic privacy level — otherwise the
    // "new version available" notice is dead code for every default-config
    // user (the gate that froze latest-version.json at the version current
    // when the privacy default flipped). Explicit opt-outs still apply; the
    // exemption logic itself is covered in
    // config.autoUpdaterDisabledReason.test.ts.
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    await runStartupUpdateCheck([])
    expect(disabledReasonOptsSeen).toEqual([
      { ignoreClaudinDefaultPrivacy: true },
    ])
    expect(writeCalls).toBe(1)
  })

  test('without the flag, dev install alone short-circuits before write', async () => {
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'development'
    await runStartupUpdateCheck([])
    expect(writeCalls).toBe(0)
  })

  test('healthy path (no flag, prod install, no opt-out) writes the cache', async () => {
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    await runStartupUpdateCheck([])
    expect(writeCalls).toBe(1)
    expect(getLatestCalls).toBe(1)
  })

  test('throttle skips when last check was 30min ago', async () => {
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000
    await writeFile(join(tmpDir, 'last-update-check'), String(thirtyMinAgo), 'utf8')
    await runStartupUpdateCheck([])
    // Throttle short-circuits before getLatestVersion, so neither npm view
    // nor the cache write fire.
    expect(getLatestCalls).toBe(0)
    expect(writeCalls).toBe(0)
  })

  test('throttle expires after 2h — call goes through', async () => {
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
    await writeFile(join(tmpDir, 'last-update-check'), String(twoHoursAgo), 'utf8')
    await runStartupUpdateCheck([])
    expect(getLatestCalls).toBe(1)
    expect(writeCalls).toBe(1)
  })

  test('future-timestamp throttle file does not block forever (clock skew)', async () => {
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    // A `last-update-check` file dated in the future (clock skew, NFS,
    // restored backup) would make `Date.now() - last < THROTTLE_MS` true
    // for any positive THROTTLE_MS — disabling the check until the wall
    // clock catches up. The guard must reject future values and let the
    // call go through.
    const oneHourAhead = Date.now() + 60 * 60 * 1000
    await writeFile(join(tmpDir, 'last-update-check'), String(oneHourAhead), 'utf8')
    await runStartupUpdateCheck([])
    expect(getLatestCalls).toBe(1)
    expect(writeCalls).toBe(1)
  })

  test('force-flag bypasses an otherwise-valid throttle window', async () => {
    process.env.CLAUDIN_FORCE_UPDATE_CHECK = '1'
    isAutoUpdaterDisabledReturn = false
    installTypeReturn = 'native'
    // A throttle file 1min old would normally block — force-flag overrides.
    const oneMinAgo = Date.now() - 60 * 1000
    await writeFile(join(tmpDir, 'last-update-check'), String(oneMinAgo), 'utf8')
    await runStartupUpdateCheck([])
    expect(getLatestCalls).toBe(1)
    expect(writeCalls).toBe(1)
  })
})

describe('THROTTLE_MS', () => {
  test('is exported (consumers and tests can introspect)', () => {
    // We deliberately do NOT pin THROTTLE_MS to a literal here — that test
    // is tautological (pinning a constant to its own literal value catches
    // nothing). The throttle behavior is covered by the "30min ago" and
    // "2h ago" tests above, which would fail if THROTTLE_MS shifts in
    // either direction past those boundaries.
    expect(typeof THROTTLE_MS).toBe('number')
    expect(THROTTLE_MS).toBeGreaterThan(0)
  })
})
