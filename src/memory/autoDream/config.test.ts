import { afterEach, describe, expect, test } from 'bun:test'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { isAutoDreamEnabled } from 'src/memory/autoDream/config.js'

function setSettings(settings: Record<string, unknown> | null): void {
  setFlagSettingsInline(settings)
  resetSettingsCache()
}

describe('isAutoDreamEnabled', () => {
  afterEach(() => setSettings(null))

  test('is off without the setting', () => {
    setSettings(null)
    expect(isAutoDreamEnabled()).toBe(false)
  })

  test('follows autoDreamEnabled', () => {
    setSettings({ autoDreamEnabled: true })
    expect(isAutoDreamEnabled()).toBe(true)
    setSettings({ autoDreamEnabled: false })
    expect(isAutoDreamEnabled()).toBe(false)
  })
})
