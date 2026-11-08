// the fallback model bypasses the `availableModels` allowlist.
// A `model` setting outside the allowlist is ignored (getUserSpecifiedModelSetting,
// model.ts:179); a `fallbackModel` setting — or --fallback-model, now also in
// the REPL — is handed to the main loop unchecked, so a 529 streak, a 5xx run
// or a long 429 moves the session onto a model the policy forbids.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setFlagSettingsInline } from 'src/platform/bootstrap/state/sessionFlags.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { isModelAllowed } from 'src/providers/model/modelAllowlist.js'
import { getFallbackModel } from 'src/providers/model/fallbackModel.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'

// Keep the user's real config dir out of the settings read.
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'fallback-allowlist-'))
beforeAll(() => {
  process.env.CLAUDIN_CONFIG_DIR = configDir
  resetSettingsCache()
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  resetSettingsCache()
  rmSync(configDir, { recursive: true, force: true })
})

afterEach(() => {
  setFlagSettingsInline(null)
  resetSettingsCache()
})

describe('fallbackModel and the availableModels allowlist', () => {
  test('a fallback outside the allowlist is not used', () => {
    setFlagSettingsInline({ availableModels: ['sonnet'], fallbackModel: 'opus' })
    resetSettingsCache()
    expect(isModelAllowed('sonnet')).toBe(true)
    expect(isModelAllowed('opus')).toBe(false)
    expect(getFallbackModel(parseUserSpecifiedModel('sonnet'))).toBeUndefined()
  })
})
