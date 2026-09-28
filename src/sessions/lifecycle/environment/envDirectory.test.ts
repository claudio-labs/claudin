/**
 * The session environment directories hold files that can export secrets,
 * and every shell command sources them: they are created owner-only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { getHookEnvFilePath } from 'src/sessions/lifecycle/environment/envDirectory.js'
import { asSessionId } from 'src/shared/types/ids.js'

let env: EnvSnapshot
let savedSessionId: string
let configDir: string

beforeAll(() => {
  env = envSnapshot(['CLAUDIN_CONFIG_DIR'])
  savedSessionId = getSessionId()
})

beforeEach(() => {
  configDir = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-env-dir-')))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  switchSession(asSessionId(randomUUID()))
})

afterEach(() => {
  env.restore()
  rmSync(configDir, { recursive: true, force: true })
})

afterAll(() => {
  env.restore()
  switchSession(asSessionId(savedSessionId))
})

const modeOf = (path: string) => statSync(path).mode & 0o777

test('session-env and the session directory under it are created owner-only', async () => {
  const hookFile = await getHookEnvFilePath('SessionStart', 0)

  expect(modeOf(join(configDir, 'session-env'))).toBe(0o700)
  expect(modeOf(dirname(hookFile))).toBe(0o700)
})
