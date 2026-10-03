/**
 * Shared set-up for the `sessions/persistence` characterization suites.
 *
 * Each test gets a fresh temp root holding a config home and a project
 * directory, a fresh session id, and the transcript writer reset, so nothing
 * written by one test is visible to the next. `usePersistenceSandbox()`
 * registers its hooks in the calling file, and puts back everything it moved
 * in that file's afterAll.
 */
import { afterAll, afterEach, beforeAll, beforeEach, setSystemTime } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { resetCostState, resetCostStateOwnerForTesting } from 'src/agent/cost-tracker.js'
import {
  getCwdState,
  getOriginalCwd,
  getPromptId,
  getSessionId,
  isSessionPersistenceDisabled,
  setCwdState,
  setFlagSettingsInline,
  setOriginalCwd,
  setPromptId,
  setSessionPersistenceDisabled,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getProjectDir,
  getTranscriptPath,
  resetProjectForTesting,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'

/** Every variable the writer or the ingress client reads; each test starts with them unset. */
const VARIABLES = [
  'CLAUDIN_CONFIG_DIR',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'CLAUDIN_SKIP_PROMPT_HISTORY',
  'ENABLE_SESSION_PERSISTENCE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_AFTER_LAST_COMPACT',
] as const

/** The writer's in-memory state: its singleton and the memo of uuids on disk. */
const WRITER_STATE: ReadonlyArray<() => void> = [resetProjectForTesting, clearSessionMessagesCache]

export type PersistenceSandbox = {
  readonly root: string
  readonly configDir: string
  readonly project: string
  /** The current session's transcript path. */
  transcript(): string
  /** The raw text of a file, or '' when it does not exist. */
  text(path?: string): string
  /** The parsed lines of a JSONL file, blank lines left out. */
  entries(path?: string): Array<Record<string, unknown>>
  /** Replace every occurrence of the temp root with `<root>`. */
  normalize(text: string): string
}

/** Run git in `cwd`, away from the user's configuration. */
export function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
}

const REPOSITORY = resolve(import.meta.dir, '..', '..', '..')

/**
 * Run `script` (an ES module body that may use top-level await) in a fresh
 * Bun process at the repository root, so `src/…` imports resolve. The child
 * gets only PATH plus `env`: no NODE_ENV, so it persists like a real run.
 */
export async function runChild(
  script: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['bun', '--preload', './src/stubs/test-preload.ts', '-e', script], {
    cwd: REPOSITORY,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function usePersistenceSandbox(): PersistenceSandbox {
  const saved: Partial<Record<(typeof VARIABLES)[number], string>> = {}
  const where = { original: '', cwd: '', session: '', prompt: null as string | null, disabled: false }
  const paths = { root: '', configDir: '', project: '' }

  beforeAll(() => {
    for (const key of VARIABLES) if (process.env[key] !== undefined) saved[key] = process.env[key]
    where.original = getOriginalCwd()
    where.cwd = getCwdState()
    where.session = getSessionId()
    where.prompt = getPromptId()
    where.disabled = isSessionPersistenceDisabled()
  })

  beforeEach(() => {
    paths.root = realpathSync(mkdtempSync(join(tmpdir(), 'persistence-char-')))
    paths.configDir = join(paths.root, 'config')
    paths.project = join(paths.root, 'project')
    mkdirSync(paths.configDir)
    mkdirSync(paths.project)
    for (const key of VARIABLES) delete process.env[key]
    process.env.CLAUDIN_CONFIG_DIR = paths.configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    setOriginalCwd(paths.project)
    setCwdState(paths.project)
    setPromptId(null)
    setSessionPersistenceDisabled(false)
    setFlagSettingsInline(null)
    resetSettingsCache()
    getProjectDir.cache.clear?.()
    for (const drop of WRITER_STATE) drop()
    switchSession(asSessionId(randomUUID()))
  })

  afterEach(async () => {
    // Whatever a test left queued lands in its own temp root before it goes.
    await Promise.resolve(flushSessionStorage())
    setSystemTime()
    for (const drop of WRITER_STATE) drop()
    setFlagSettingsInline(null)
    resetSettingsCache()
    setOriginalCwd(where.original)
    setCwdState(where.cwd)
    rmSync(paths.root, { recursive: true, force: true })
  })

  afterAll(() => {
    for (const key of VARIABLES) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    switchSession(asSessionId(where.session))
    setPromptId(where.prompt)
    setSessionPersistenceDisabled(where.disabled)
    getProjectDir.cache.clear?.()
    resetCostState()
    resetCostStateOwnerForTesting()
  })

  const text = (path?: string): string => {
    const file = path ?? getTranscriptPath()
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  return {
    get root() {
      return paths.root
    },
    get configDir() {
      return paths.configDir
    },
    get project() {
      return paths.project
    },
    transcript: () => getTranscriptPath(),
    text,
    entries: path =>
      text(path)
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>),
    normalize: value => value.split(paths.root).join('<root>'),
  }
}
