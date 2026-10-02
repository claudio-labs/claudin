/**
 * Characterization of `init()` (src/platform/entrypoints/init.ts), the
 * once-per-process setup every executing command awaits, pinned before the
 * lever cut removes its remote-settings, policy-limits and upstream-proxy
 * steps.
 *
 * What a caller can see once `init()` settles:
 * - the environment from the user's global config is in `process.env`;
 * - the first start time is recorded, and an earlier one is kept;
 * - the session's scratchpad directory exists, unless CLAUDIN_SCRATCHPAD
 *   turns it off;
 * - a second call is the same call: nothing runs again;
 * - a failure that is not a config parse error rejects the call.
 *
 * Not pinned: the ConfigParseError branch, which fires only when init() is
 * the first caller of enableConfigs() in the process, which a shared
 * `bun test` process cannot arrange; and the signal handlers, which are
 * installed once per process (useBootSandbox removes them again).
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getScratchpadDir } from 'src/agent/scratchpad.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { init } from 'src/platform/entrypoints/init.js'
import { useBootSandbox } from 'src/platform/main/__testutils__/bootHarness.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'

const sandbox = useBootSandbox(['CHAR_INIT_FROM_CONFIG', 'CHAR_INIT_SECOND'])

describe('init()', () => {
  test('puts the global config environment into process.env', async () => {
    saveGlobalConfig(current => ({ ...current, env: { CHAR_INIT_FROM_CONFIG: 'from-config' } }))
    await init()
    expect(process.env.CHAR_INIT_FROM_CONFIG).toBe('from-config')
  })

  test('records the first start time once and keeps an earlier one', async () => {
    saveGlobalConfig(current => ({ ...current, firstStartTime: undefined }))
    const before = Date.now()
    await init()
    const recorded = getGlobalConfig().firstStartTime
    expect(typeof recorded).toBe('string')
    expect(Date.parse(recorded!)).toBeGreaterThanOrEqual(before - 1000)

    const earlier = '2020-01-02T03:04:05.000Z'
    saveGlobalConfig(current => ({ ...current, firstStartTime: earlier }))
    init.cache.clear?.()
    await init()
    expect(getGlobalConfig().firstStartTime).toBe(earlier)
  })

  const scratchpadCases = [
    { setting: undefined, created: true },
    { setting: '1', created: true },
    { setting: '0', created: false },
    { setting: 'false', created: false },
  ]
  for (const c of scratchpadCases) {
    test(`CLAUDIN_SCRATCHPAD=${c.setting ?? '(unset)'}: scratchpad directory created=${c.created}`, async () => {
      if (c.setting !== undefined) process.env.CLAUDIN_SCRATCHPAD = c.setting
      const dir = getScratchpadDir()
      expect(dir.startsWith(join(sandbox.root, 'tmp'))).toBe(true)
      await init()
      expect(existsSync(dir)).toBe(c.created)
    })
  }

  test('runs once: a second call settles without doing the work again', async () => {
    saveGlobalConfig(current => ({ ...current, env: { CHAR_INIT_FROM_CONFIG: 'first' } }))
    const first = init()
    await first
    saveGlobalConfig(current => ({ ...current, env: { CHAR_INIT_SECOND: 'second' } }))
    const second = init()
    expect(second).toBe(first)
    await second
    expect(process.env.CHAR_INIT_SECOND).toBeUndefined()
  })

  test('a failure that is not a config parse error rejects the call', async () => {
    // A temp root that is a file: the scratchpad directory cannot be made under it.
    const blocked = join(sandbox.root, 'not-a-dir')
    writeFileSync(blocked, 'x')
    process.env.CLAUDIN_TMPDIR = blocked
    getClaudeTempDir.cache.clear?.()
    let failure: unknown
    try {
      await init()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as NodeJS.ErrnoException).code).toMatch(/^(ENOTDIR|EEXIST)$/)
  })
})
