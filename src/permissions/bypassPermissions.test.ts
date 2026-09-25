/**
 * The bypass-permissions killswitch.
 *
 * `createDisabledBypassPermissionsContext` is the security-relevant half: the
 * context it returns must be one that cannot bypass, both by flag and by mode.
 *
 * `isBypassPermissionsModeDisabled` reads the merged settings files, so its
 * result is ambient and it is covered by the surface pin instead — see the
 * report accompanying this commit. `checkAndDisableBypassPermissions` is only
 * exercised on its early-return path here: its other arm calls
 * `gracefulShutdown`, which would take the test runner with it.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetGrowthBook } from 'src/platform/analytics/growthbook.js'
import {
  checkAndDisableBypassPermissions,
  createDisabledBypassPermissionsContext,
  initialPermissionModeFromCLI,
  isBypassPermissionsModeDisabled,
  shouldDisableBypassPermissions,
} from 'src/permissions/permissionSetup.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

const REAL_FLAGS_FILE = process.env.CLAUDE_FEATURE_FLAGS_FILE
const flagDirs: string[] = []

function withFlags(flags: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), 'bypass-flags-'))
  flagDirs.push(dir)
  const file = join(dir, 'feature-flags.json')
  writeFileSync(file, JSON.stringify(flags))
  process.env.CLAUDE_FEATURE_FLAGS_FILE = file
  resetGrowthBook()
}

afterEach(() => {
  if (REAL_FLAGS_FILE === undefined) {
    delete process.env.CLAUDE_FEATURE_FLAGS_FILE
  } else {
    process.env.CLAUDE_FEATURE_FLAGS_FILE = REAL_FLAGS_FILE
  }
  resetGrowthBook()
})

afterAll(() => {
  for (const dir of flagDirs) rmSync(dir, { recursive: true, force: true })
})

function ctx(
  mode: PermissionMode,
  isBypassPermissionsModeAvailable: boolean,
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable,
  } as ToolPermissionContext
}

describe('createDisabledBypassPermissionsContext', () => {
  test('the returned context cannot bypass', () => {
    const after = createDisabledBypassPermissionsContext(
      ctx('bypassPermissions', true),
    )
    expect(after.isBypassPermissionsModeAvailable).toBe(false)
    expect(after.mode).not.toBe('bypassPermissions')
  })

  test('a session already in bypass mode is dropped to default', () => {
    expect(
      createDisabledBypassPermissionsContext(ctx('bypassPermissions', true))
        .mode,
    ).toBe('default')
  })

  test('a session in another mode keeps that mode', () => {
    // Only bypass is revoked — kicking an acceptEdits session to default
    // would be an unrelated downgrade.
    expect(
      createDisabledBypassPermissionsContext(ctx('acceptEdits', true)).mode,
    ).toBe('acceptEdits')
    expect(createDisabledBypassPermissionsContext(ctx('plan', true)).mode).toBe(
      'plan',
    )
  })

  test('availability is revoked even when the session was never in bypass mode', () => {
    expect(
      createDisabledBypassPermissionsContext(ctx('default', true))
        .isBypassPermissionsModeAvailable,
    ).toBe(false)
  })

  test('the input context is not mutated', () => {
    const before = ctx('bypassPermissions', true)
    createDisabledBypassPermissionsContext(before)
    expect(before.mode).toBe('bypassPermissions')
    expect(before.isBypassPermissionsModeAvailable).toBe(true)
  })
})

describe('shouldDisableBypassPermissions', () => {
  test('resolves false — this fork has no remote killswitch', async () => {
    expect(await shouldDisableBypassPermissions()).toBe(false)
  })

  test('a local flag file cannot turn the killswitch on', async () => {
    // tengu_disable_bypass_permissions_mode is a SECURITY_RESTRICTION: letting
    // a file set it would only let someone lock themselves out of a mode they
    // explicitly asked for, with nothing explaining the refusal.
    withFlags({ tengu_disable_bypass_permissions_mode: true })
    expect(await shouldDisableBypassPermissions()).toBe(false)
  })
})

describe('checkAndDisableBypassPermissions', () => {
  test('returns without effect when bypass is already unavailable', async () => {
    await expect(
      checkAndDisableBypassPermissions(ctx('default', false)),
    ).resolves.toBeUndefined()
  })
})

describe('initialPermissionModeFromCLI — a stock install', () => {
  test('--dangerously-skip-permissions starts in bypass mode, with no notice', () => {
    // Asserted where the session's first mode is decided, so it holds whether
    // a refusal could come from a flag or only from settings.
    expect(
      initialPermissionModeFromCLI({
        permissionModeCli: undefined,
        dangerouslySkipPermissions: true,
      }),
    ).toEqual({ mode: 'bypassPermissions', notification: undefined })
  })
})

describe('isBypassPermissionsModeDisabled', () => {
  test('answers with a boolean and does not throw', () => {
    // Surface-level only: the settings half is ambient (it reads the merged
    // settings files) and the GrowthBook half is pinned in growthbook.test.ts,
    // so there is nothing here a probe against permissionSetup could move.
    expect(typeof isBypassPermissionsModeDisabled()).toBe('boolean')
  })
})
