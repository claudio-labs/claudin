import { afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

/**
 * Points the user settings at an empty config dir for the calling test file,
 * so a test that runs real hooks (UserPromptSubmit, WorktreeRemove) runs only
 * the ones it registers, never one from the developer's own settings.json.
 * Call it at the top level of the file; the hooks register in its scope.
 */
export function useIsolatedHooksConfig(): void {
  let saved: string | undefined
  let dir = ''
  beforeAll(() => {
    saved = process.env.CLAUDIN_CONFIG_DIR
    dir = mkdtempSync(join(tmpdir(), 'hooks-config-'))
    process.env.CLAUDIN_CONFIG_DIR = dir
    resetSettingsCache()
    resetHooksConfigSnapshot()
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = saved
    resetSettingsCache()
    resetHooksConfigSnapshot()
    rmSync(dir, { recursive: true, force: true })
  })
}
