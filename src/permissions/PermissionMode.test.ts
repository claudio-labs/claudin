import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  externalPermissionModeSchema,
  getModeColor,
  isDefaultMode,
  isExternalPermissionMode,
  permissionModeFromString,
  permissionModeSchema,
  permissionModeSymbol,
  permissionModeTitle,
  toExternalPermissionMode,
} from 'src/permissions/PermissionMode.js'

// `auto` is configured only under TRANSCRIPT_CLASSIFIER, which reads false
// under bun test: here it resolves to the default mode, like any unknown mode.

let saved: string | undefined
beforeEach(() => {
  saved = process.env.CLAUDIN_NERD_FONT
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = saved
})

describe('permissionModeSymbol', () => {
  test('without a Nerd Font: the ⏸/⏵⏵ symbols, none for default', () => {
    process.env.CLAUDIN_NERD_FONT = '0'
    expect(permissionModeSymbol('default')).toBe('')
    expect(permissionModeSymbol('plan')).toBe('\u23f8')
    expect(permissionModeSymbol('acceptEdits')).toBe('⏵⏵')
    expect(permissionModeSymbol('bypassPermissions')).toBe('⏵⏵')
    expect(permissionModeSymbol('dontAsk')).toBe('⏵⏵')
  })

  test('with a Nerd Font: one icon per mode, still none for default', () => {
    process.env.CLAUDIN_NERD_FONT = '1'
    expect(permissionModeSymbol('default')).toBe('')
    expect(permissionModeSymbol('plan')).toBe('\u{f0982}')
    expect(permissionModeSymbol('acceptEdits')).toBe('\u{f0dc9}')
    expect(permissionModeSymbol('bypassPermissions')).toBe('\u{f099c}')
    expect(permissionModeSymbol('dontAsk')).toBe('\u{f099c}')
  })

  test('a mode that falls back to default gets no icon either', () => {
    process.env.CLAUDIN_NERD_FONT = '1'
    expect(permissionModeSymbol('bubble')).toBe('')
    // `auto` has an icon of its own, but here it is not configured (see top),
    // so it shows what default shows: nothing.
    expect(permissionModeSymbol('auto')).toBe('')
  })
})

describe('mode config lookups', () => {
  test('title, color and external mode per mode', () => {
    expect(permissionModeTitle('plan')).toBe('Plan Mode')
    expect(permissionModeTitle('acceptEdits')).toBe('Accept edits')
    expect(getModeColor('bypassPermissions')).toBe('error')
    expect(getModeColor('default')).toBe('text')
    expect(toExternalPermissionMode('dontAsk')).toBe('dontAsk')
    expect(toExternalPermissionMode('bubble')).toBe('default')
  })

  test('permissionModeFromString keeps known modes and defaults the rest', () => {
    expect(permissionModeFromString('plan')).toBe('plan')
    expect(permissionModeFromString('acceptEdits')).toBe('acceptEdits')
    expect(permissionModeFromString('nonsense')).toBe('default')
  })

  test('isDefaultMode and isExternalPermissionMode', () => {
    expect(isDefaultMode('default')).toBe(true)
    expect(isDefaultMode(undefined)).toBe(true)
    expect(isDefaultMode('plan')).toBe(false)
    expect(isExternalPermissionMode('plan')).toBe(true)
    expect(isExternalPermissionMode('auto')).toBe(false)
  })

  test('the schemas accept the addressable modes only', () => {
    expect(permissionModeSchema().safeParse('plan').success).toBe(true)
    expect(permissionModeSchema().safeParse('bubble').success).toBe(false)
    expect(externalPermissionModeSchema().safeParse('dontAsk').success).toBe(true)
    expect(externalPermissionModeSchema().safeParse('auto').success).toBe(false)
  })
})
