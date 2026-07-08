import { describe, expect, test } from 'bun:test'
import type { PermissionMode } from 'src/types/permissions.js'
import { clampMode, MODE_RANK } from './permissionClamp.js'

describe('clampMode', () => {
  test('returns the less permissive of desired vs session', () => {
    // desired above session → clamped down to session
    expect(clampMode('bypassPermissions', 'default')).toBe('default')
    expect(clampMode('acceptEdits', 'plan')).toBe('plan')
    // desired at or below session → desired is kept
    expect(clampMode('plan', 'default')).toBe('plan')
    expect(clampMode('default', 'bypassPermissions')).toBe('default')
    // equal → either value (they rank the same)
    expect(clampMode('acceptEdits', 'acceptEdits')).toBe('acceptEdits')
  })

  test('absent desired mode falls back to the session mode', () => {
    expect(clampMode(undefined, 'default')).toBe('default')
    expect(clampMode(undefined, 'bypassPermissions')).toBe('bypassPermissions')
  })

  test('an unranked desired mode cannot bypass the clamp — falls back to session', () => {
    // A junk agent-def mode must not be forwarded as-is (it would sidestep the
    // rank comparison). It degrades to the session mode.
    expect(clampMode('godmode' as PermissionMode, 'default')).toBe('default')
    expect(clampMode('' as PermissionMode, 'plan')).toBe('plan')
  })

  test('an unranked session mode is treated as `default` rank, never elevated', () => {
    // Session rank defaults to 1 (default) when unknown; a higher desired mode
    // is still clamped to that session string, not silently promoted.
    expect(clampMode('bypassPermissions', 'weird' as PermissionMode)).toBe('weird' as PermissionMode)
    expect(clampMode('plan', 'weird' as PermissionMode)).toBe('plan')
  })

  test('MODE_RANK orders modes from least to most permissive', () => {
    expect(MODE_RANK.plan).toBeLessThan(MODE_RANK.default)
    expect(MODE_RANK.default).toBeLessThan(MODE_RANK.acceptEdits)
    expect(MODE_RANK.acceptEdits).toBeLessThan(MODE_RANK.bypassPermissions)
  })
})
