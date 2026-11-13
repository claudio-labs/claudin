import { afterEach, describe, expect, test } from 'bun:test'

import {
  AUTO_COMPACT_WINDOW_ENV,
  configuredAutoCompactWindow,
} from 'src/agent/compact/autoCompactWindow.ts'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

function setSettings(settings: Record<string, unknown> | null): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

describe('configuredAutoCompactWindow', () => {
  const saved = process.env[AUTO_COMPACT_WINDOW_ENV]
  afterEach(() => {
    setSettings(null)
    if (saved === undefined) delete process.env[AUTO_COMPACT_WINDOW_ENV]
    else process.env[AUTO_COMPACT_WINDOW_ENV] = saved
  })

  test('auto with neither the env var nor a saved window', () => {
    delete process.env[AUTO_COMPACT_WINDOW_ENV]
    setSettings({ modelSettings: { 'other-model': { autoCompactWindow: 200_000 } } })
    expect(configuredAutoCompactWindow('claude-sonnet-4')).toEqual({ source: 'auto' })
  })

  test('the saved window for this model', () => {
    delete process.env[AUTO_COMPACT_WINDOW_ENV]
    setSettings({ modelSettings: { 'claude-sonnet-4': { autoCompactWindow: 200_000 } } })
    expect(configuredAutoCompactWindow('claude-sonnet-4')).toEqual({ source: 'settings', window: 200_000 })
  })

  test('the env var first, and only when it parses to a positive number', () => {
    setSettings({ modelSettings: { 'claude-sonnet-4': { autoCompactWindow: 200_000 } } })
    process.env[AUTO_COMPACT_WINDOW_ENV] = '300000'
    expect(configuredAutoCompactWindow('claude-sonnet-4')).toEqual({ source: 'env', window: 300_000 })
    process.env[AUTO_COMPACT_WINDOW_ENV] = 'nonsense'
    expect(configuredAutoCompactWindow('claude-sonnet-4')).toEqual({ source: 'settings', window: 200_000 })
  })

  test('an invalid saved value counts as auto', () => {
    delete process.env[AUTO_COMPACT_WINDOW_ENV]
    setSettings({ modelSettings: { 'claude-sonnet-4': { autoCompactWindow: -1 } } })
    expect(configuredAutoCompactWindow('claude-sonnet-4')).toEqual({ source: 'auto' })
  })
})
