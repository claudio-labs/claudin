import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import { getClaudeTempDir, getProjectTempDir } from 'src/platform/tmpdir.js'
import type { SessionId } from 'src/shared/types/ids.js'
import {
  createScratchpadDirOnSessionSwitch,
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

// Everything these tests create goes under a temp root of their own, the
// per-project dir included: the recursive mkdir creates that one too where it
// was missing (a fresh CI runner, a new worktree), and the real /tmp keeps it.
const savedTmpdir = process.env.CLAUDIN_TMPDIR
let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scratchpad-test-'))
  process.env.CLAUDIN_TMPDIR = root
  getClaudeTempDir.cache.clear?.()
})

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.CLAUDIN_TMPDIR
  else process.env.CLAUDIN_TMPDIR = savedTmpdir
  getClaudeTempDir.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
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
  expect(getProjectTempDir().startsWith(root)).toBe(true)
  expect(getScratchpadDir()).toBe(
    join(getProjectTempDir(), getSessionId(), 'scratchpad'),
  )
})

describe('ensureScratchpadDir', () => {
  test('creates the current session directory, owner-only, and returns it', async () => {
    delete process.env[ENV]
    const dir = await ensureScratchpadDir()
    expect(dir).toBe(getScratchpadDir())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('refuses when the killswitch is set', async () => {
    process.env[ENV] = '0'
    await expect(ensureScratchpadDir()).rejects.toThrow('not enabled')
  })
})

// init() creates the first session's directory. /clear, /new, /resume and
// --resume move getScratchpadDir() to a new id, which the system prompt
// then names: a shell write into it failed on the missing directory.
describe('a session switch', () => {
  let unsubscribe: () => void
  beforeAll(() => {
    unsubscribe = createScratchpadDirOnSessionSwitch()
  })
  afterAll(() => unsubscribe())

  function switchAndBack(check: (next: string) => void): void {
    const before = getSessionId()
    const next = randomUUID() as SessionId
    switchSession(next)
    try {
      check(next)
    } finally {
      switchSession(before)
    }
  }

  test('creates the new session directory', () => {
    delete process.env[ENV]
    switchAndBack(() => {
      expect(existsSync(getScratchpadDir())).toBe(true)
      expect(statSync(getScratchpadDir()).mode & 0o777).toBe(0o700)
    })
  })

  test('creates nothing with the killswitch set', () => {
    process.env[ENV] = '0'
    switchAndBack(next => {
      expect(existsSync(join(getProjectTempDir(), next))).toBe(false)
    })
  })

  // init() is the whole boot sequence; the call is pinned on its text.
  test('init() subscribes it after creating the first directory', () => {
    const init = readFileSync(
      new URL('../platform/entrypoints/init.ts', import.meta.url),
      'utf8',
    )
    expect(init).toMatch(
      /await ensureScratchpadDir\(\)\s+createScratchpadDirOnSessionSwitch\(\)/,
    )
  })
})
