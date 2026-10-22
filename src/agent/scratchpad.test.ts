import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'

import { getSessionId } from 'src/platform/bootstrap/state.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import {
  ensureScratchpadDir,
  getScratchpadDir,
  isScratchpadEnabled,
} from 'src/agent/scratchpad.js'

const ENV = 'CLAUDIN_SCRATCHPAD'
const saved = process.env[ENV]

afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

// Session dirs this file created under the real project temp dir; one that
// already existed belongs to someone else and stays.
const created = new Set<string>()

function trackSessionDir(sessionId: string): void {
  const dir = join(getProjectTempDir(), sessionId)
  if (!existsSync(dir)) created.add(dir)
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('isScratchpadEnabled', () => {
  test('on unless CLAUDIN_SCRATCHPAD=0', () => {
    delete process.env[ENV]
    expect(isScratchpadEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(isScratchpadEnabled()).toBe(false)
  })
})

test('the directory is per session, under the project temp dir', () => {
  expect(getScratchpadDir()).toBe(
    join(getProjectTempDir(), getSessionId(), 'scratchpad'),
  )
})

describe('ensureScratchpadDir', () => {
  test('creates the current session directory, owner-only, and returns it', async () => {
    delete process.env[ENV]
    trackSessionDir(getSessionId())
    const dir = await ensureScratchpadDir()
    expect(dir).toBe(getScratchpadDir())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('refuses when the killswitch is set', async () => {
    process.env[ENV] = '0'
    await expect(ensureScratchpadDir()).rejects.toThrow('not enabled')
  })
})
