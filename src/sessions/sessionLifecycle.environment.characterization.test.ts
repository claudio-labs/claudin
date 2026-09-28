/**
 * Characterization of the environment a session hands to the shells it
 * spawns, pinned before the clean-base rewrite of `sessions/lifecycle`:
 *
 * - sessionEnvironment.ts: the per-session directory where SessionStart,
 *   Setup, CwdChanged and FileChanged hooks leave `export` lines, and the
 *   script assembled from it (after CLAUDIN_ENV_FILE) that the shell provider
 *   sources before every command;
 * - sessionEnvVars.ts: the session-scoped variables for child processes.
 *
 * The directory lives under a temp CLAUDIN_CONFIG_DIR. The file names and the
 * combined script are pinned by the fixtures in
 * `__fixtures__/rewrite/session-env/`. How a real hook comes to write there is
 * in sessionLifecycle.hooks.characterization.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomUUID } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  clearCwdEnvFiles,
  getHookEnvFilePath,
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from 'src/sessions/sessionEnvironment.js'
import { clearSessionEnvVars, getSessionEnvVars } from 'src/sessions/sessionEnvVars.js'
import { asSessionId } from 'src/shared/types/ids.js'

const ENV_FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite', 'session-env')

let env: EnvSnapshot
let savedSessionId: string
let sandbox: string
let configDir: string

beforeAll(() => {
  env = envSnapshot(['CLAUDIN_CONFIG_DIR', 'CLAUDIN_ENV_FILE'])
  savedSessionId = getSessionId()
})

/** Make `id` the current session, with no environment script left cached. */
function enterSession(id: string): void {
  switchSession(asSessionId(id))
  invalidateSessionEnvCache()
}

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-env-')))
  configDir = join(sandbox, 'config')
  mkdirSync(configDir)
  process.env.CLAUDIN_CONFIG_DIR = configDir
  delete process.env.CLAUDIN_ENV_FILE
  enterSession(randomUUID())
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  env.restore()
})

afterAll(() => {
  env.restore()
  enterSession(savedSessionId)
})

/** Where the current session's hook env files live, created by the test. */
function sessionEnvDir(): string {
  const dir = join(configDir, 'session-env', getSessionId())
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('the session environment directory', () => {
  test('is <config>/session-env/<session id>, created when a hook file path is asked for', async () => {
    const expected = join(configDir, 'session-env', getSessionId())
    expect(existsSync(expected)).toBe(false)

    expect(dirname(await getHookEnvFilePath('SessionStart', 0))).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  test('follows the session in effect at each call', async () => {
    const first = dirname(await getHookEnvFilePath('Setup', 0))
    const next = randomUUID()
    switchSession(asSessionId(next))

    const second = dirname(await getHookEnvFilePath('Setup', 0))

    expect(second).toBe(join(configDir, 'session-env', next))
    expect(first).not.toBe(second)
  })

  test.each([
    ['Setup', 0, 'setup-hook-0.sh'],
    ['SessionStart', 3, 'sessionstart-hook-3.sh'],
    ['CwdChanged', 1, 'cwdchanged-hook-1.sh'],
    ['FileChanged', 12, 'filechanged-hook-12.sh'],
  ] as const)('the %s hook at index %d writes to %s', async (event, index, fileName) => {
    const path = await getHookEnvFilePath(event, index)

    expect(path).toBe(join(configDir, 'session-env', getSessionId(), fileName))
    expect(existsSync(dirname(path))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })
})

describe('getSessionEnvironmentScript', () => {
  function seedHookFiles(): void {
    const dir = sessionEnvDir()
    const source = join(ENV_FIXTURES, 'hook-files')
    for (const name of readdirSync(source)) copyFileSync(join(source, name), join(dir, name))
  }

  test('is null when there is nothing to source', async () => {
    expect(await getSessionEnvironmentScript()).toBeNull()
  })

  test('joins CLAUDIN_ENV_FILE and the hook files, by event then index, each trimmed, empty ones left out', async () => {
    seedHookFiles()
    process.env.CLAUDIN_ENV_FILE = join(ENV_FIXTURES, 'parent-env.sh')

    const script = await getSessionEnvironmentScript()

    const expected = readFileSync(join(ENV_FIXTURES, 'expected-script.sh'), 'utf8')
    expect(script).toBe(expected.replace(/\n$/, ''))
  })

  test('the hook files alone, when CLAUDIN_ENV_FILE is unset', async () => {
    const dir = sessionEnvDir()
    writeFileSync(join(dir, 'cwdchanged-hook-0.sh'), 'export B=2\n')
    writeFileSync(join(dir, 'setup-hook-0.sh'), 'export A=1\n')

    expect(await getSessionEnvironmentScript()).toBe('export A=1\nexport B=2')
  })

  test('CLAUDIN_ENV_FILE alone, when there are no hook files', async () => {
    process.env.CLAUDIN_ENV_FILE = join(ENV_FIXTURES, 'parent-env.sh')

    expect(await getSessionEnvironmentScript()).toBe('export FROM_PARENT=1')
  })

  test('a CLAUDIN_ENV_FILE that is missing, empty or a directory adds nothing', async () => {
    writeFileSync(join(sessionEnvDir(), 'setup-hook-0.sh'), 'export A=1')
    const empty = join(sandbox, 'empty.sh')
    writeFileSync(empty, '  \n')

    const scripts: Array<string | null> = []
    for (const envFile of [join(sandbox, 'missing.sh'), empty, sandbox]) {
      process.env.CLAUDIN_ENV_FILE = envFile
      invalidateSessionEnvCache()
      scripts.push(await getSessionEnvironmentScript())
    }

    expect(scripts).toEqual(Array(3).fill('export A=1'))
  })

  test('a hook file that cannot be read is skipped', async () => {
    const dir = sessionEnvDir()
    writeFileSync(join(dir, 'setup-hook-0.sh'), 'export A=1')
    mkdirSync(join(dir, 'sessionstart-hook-0.sh'))
    writeFileSync(join(dir, 'filechanged-hook-0.sh'), 'export C=3')

    expect(await getSessionEnvironmentScript()).toBe('export A=1\nexport C=3')
  })

  test('the result is kept until the cache is invalidated, a null result too', async () => {
    const dir = sessionEnvDir()
    const answers: Array<string | null> = [await getSessionEnvironmentScript()]

    writeFileSync(join(dir, 'setup-hook-0.sh'), 'export A=1')
    answers.push(await getSessionEnvironmentScript())
    invalidateSessionEnvCache()
    answers.push(await getSessionEnvironmentScript())

    writeFileSync(join(dir, 'setup-hook-1.sh'), 'export B=2')
    answers.push(await getSessionEnvironmentScript())
    invalidateSessionEnvCache()
    answers.push(await getSessionEnvironmentScript())

    expect(answers).toEqual([
      null,
      null,
      'export A=1',
      'export A=1',
      'export A=1\nexport B=2',
    ])
  })

  test('switching the session keeps the cached script until it is invalidated', async () => {
    writeFileSync(join(sessionEnvDir(), 'sessionstart-hook-0.sh'), 'export VENV=old')
    const before = await getSessionEnvironmentScript()

    switchSession(asSessionId(randomUUID()))
    const afterSwitch = await getSessionEnvironmentScript()
    invalidateSessionEnvCache()
    const afterInvalidation = await getSessionEnvironmentScript()

    expect([before, afterSwitch, afterInvalidation]).toEqual([
      'export VENV=old',
      'export VENV=old',
      null,
    ])
  })
})

describe('clearCwdEnvFiles', () => {
  test('empties the cwd-changed and file-changed hook files and leaves every other file alone', async () => {
    const dir = sessionEnvDir()
    const contents: Record<string, string> = {
      'setup-hook-0.sh': 'export A=1',
      'sessionstart-hook-0.sh': 'export B=2',
      'cwdchanged-hook-0.sh': 'export C=3',
      'cwdchanged-hook-7.sh': 'export D=4',
      'filechanged-hook-2.sh': 'export E=5',
      'cwdchanged-hook-x.sh': 'export F=6',
      'filechanged-hook-1.sh.bak': 'export G=7',
      'notes.txt': 'keep me',
    }
    for (const [name, body] of Object.entries(contents)) writeFileSync(join(dir, name), body)

    await clearCwdEnvFiles()

    const emptied = new Set(['cwdchanged-hook-0.sh', 'cwdchanged-hook-7.sh', 'filechanged-hook-2.sh'])
    const after = Object.fromEntries(
      Object.keys(contents).map(name => [name, readFileSync(join(dir, name), 'utf8')]),
    )
    expect(after).toEqual(
      Object.fromEntries(
        Object.entries(contents).map(([name, body]) => [name, emptied.has(name) ? '' : body]),
      ),
    )
  })

  test('once invalidated, the script no longer carries what was cleared', async () => {
    const dir = sessionEnvDir()
    writeFileSync(join(dir, 'setup-hook-0.sh'), 'export A=1')
    writeFileSync(join(dir, 'cwdchanged-hook-0.sh'), 'export IN_DIR=old')

    await clearCwdEnvFiles()
    invalidateSessionEnvCache()

    expect(await getSessionEnvironmentScript()).toBe('export A=1')
  })

  test('resolves quietly when the session has no environment files yet', async () => {
    await clearCwdEnvFiles()

    const dir = join(configDir, 'session-env', getSessionId())
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })
})

describe('session-scoped variables for child processes', () => {
  test('there are none, and clearing keeps it that way', () => {
    expect([...getSessionEnvVars()]).toEqual([])

    clearSessionEnvVars()

    expect(getSessionEnvVars().size).toBe(0)
  })
})
