/**
 * The bypass-permissions killswitch.
 *
 * `createDisabledBypassPermissionsContext` is the security-relevant half: the
 * context it returns must be one that cannot bypass, both by flag and by mode.
 *
 * `isBypassPermissionsModeDisabled` reads the merged settings files, so its
 * result is ambient and it is covered by the surface pin instead — see the
 * report accompanying this commit.
 */
import { describe, expect, test } from 'bun:test'
import {
  createDisabledBypassPermissionsContext,
  initialPermissionModeFromCLI,
  isBypassPermissionsModeDisabled,
} from 'src/permissions/permissionSetup.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

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
    // settings files), so there is nothing here a probe against
    // permissionSetup could move.
    expect(typeof isBypassPermissionsModeDisabled()).toBe('boolean')
  })
})
