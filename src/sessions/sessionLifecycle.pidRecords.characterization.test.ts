/**
 * Characterization of the per-process session records (concurrentSessions.ts),
 * pinned before the clean-base rewrite of `sessions/lifecycle`.
 *
 * Every running CLI keeps `<config dir>/sessions/<pid>.json`. Other instances
 * read those records to count concurrent sessions, to list the sessions they
 * could resume, and to find peers. The tests drive the real module against a
 * temp CLAUDIN_CONFIG_DIR, with real child processes standing in for "another
 * live session". What only a whole process can show (the promise that settles
 * once per process, and the record removed by the shutdown cleanup) runs in a
 * nested `bun test` of its own, so this process's module state stays out of it.
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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from 'src/agent/coordinator/teammate.js'
import {
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
  setOriginalCwd,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import {
  envSnapshot,
  eventually,
  runInFreshProcess,
  type EnvSnapshot,
} from 'src/sessions/__testutils__/lifecycleHarness.js'
import {
  countConcurrentSessions,
  listLiveSessions,
  registerSession,
  updateSessionBridgeId,
  updateSessionCwd,
  updateSessionInbox,
  updateSessionName,
  updateSessionPresence,
  updateSessionStatus,
  whenSessionRegistered,
} from 'src/sessions/concurrentSessions.js'
import { asSessionId } from 'src/shared/types/ids.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
/** Above Linux's pid_max, so nothing can ever be running under it. */
const NEVER_A_PID = 99_999_999

let env: EnvSnapshot
let savedSessionId: string
let savedOriginalCwd: string

let sandbox: string
let configDir: string
let sessionsDir: string
let ownRecord: string
const children: Array<{ kill(): void }> = []

beforeAll(() => {
  env = envSnapshot(['CLAUDIN_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT'])
  savedSessionId = getSessionId()
  savedOriginalCwd = getOriginalCwd()
})

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-pid-')))
  configDir = join(sandbox, 'config')
  mkdirSync(configDir)
  sessionsDir = join(configDir, 'sessions')
  ownRecord = join(sessionsDir, `${process.pid}.json`)
  process.env.CLAUDIN_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  clearDynamicTeamContext()
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  clearDynamicTeamContext()
  env.restore()
  rmSync(sandbox, { recursive: true, force: true })
})

afterAll(() => {
  env.restore()
  switchSession(asSessionId(savedSessionId))
  setOriginalCwd(savedOriginalCwd)
})

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function readFixture(name: string): Record<string, unknown> {
  return readJson(join(FIXTURES, name))
}

/** The low 9 bits of a file's mode. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** A process that stays alive until the test ends: "another live session". */
function spawnLiveProcess(): number {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  children.push(child)
  return child.pid
}

function writeRecord(pid: number | string, body: unknown): string {
  mkdirSync(sessionsDir, { recursive: true })
  const path = join(sessionsDir, `${pid}.json`)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

/**
 * Replace what differs per run with the placeholders the fixtures use: the
 * pid, the session id, the start time, and the cwd while it is still the
 * original one.
 */
function normalizeRecord(
  record: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  expect(record.pid).toBe(process.pid)
  expect(record.sessionId).toBe(sessionId)
  expect(typeof record.startedAt).toBe('number')
  return {
    ...record,
    pid: '<pid>',
    sessionId: '<session id>',
    startedAt: '<epoch ms>',
    ...(record.cwd === sandbox && { cwd: '<original cwd>' }),
  }
}

describe('registerSession — the record a starting session writes', () => {
  test('writes <config>/sessions/<pid>.json with the session, the original cwd, the start time and the host', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    switchSession(asSessionId(randomUUID()))
    setOriginalCwd(sandbox)
    const before = Date.now()

    const registered = await registerSession()

    const after = Date.now()
    expect(registered).toBe(true)
    const record = readJson(ownRecord)
    expect(record.startedAt as number).toBeGreaterThanOrEqual(before)
    expect(record.startedAt as number).toBeLessThanOrEqual(after)
    expect(record.cwd).toBe(sandbox)
    expect(normalizeRecord(record, getSessionId())).toEqual(
      readFixture('pid-record.registered.json'),
    )
  })

  test('the record is owner-only, and so is the directory holding it', async () => {
    await registerSession()

    expect(modeOf(ownRecord)).toBe(0o600)
    expect(modeOf(sessionsDir)).toBe(0o700)
  })

  test('an existing sessions directory with looser permissions is tightened', async () => {
    mkdirSync(sessionsDir, { mode: 0o755 })
    chmodSync(sessionsDir, 0o755)

    await registerSession()

    expect(modeOf(sessionsDir)).toBe(0o700)
  })

  test('without CLAUDE_CODE_ENTRYPOINT the record has no entrypoint key', async () => {
    await registerSession()

    expect(Object.keys(readJson(ownRecord))).not.toContain('entrypoint')
  })

  test('a teammate process does not register', async () => {
    setDynamicTeamContext({
      agentId: 'worker-1',
      agentName: 'worker',
      teamName: 'crew',
      planModeRequired: false,
    })

    expect(await registerSession()).toBe(false)
    expect(existsSync(sessionsDir)).toBe(false)
  })

  test('a failure to write resolves false instead of throwing', async () => {
    writeFileSync(sessionsDir, 'a file where the directory should be')

    expect(await registerSession()).toBe(false)
  })

  test('the record follows the session when /resume or /clear switches it', async () => {
    await registerSession()
    const resumed = randomUUID()

    switchSession(asSessionId(resumed))
    const afterResume = await eventually(
      () => readJson(ownRecord).sessionId,
      id => id === resumed,
    )
    expect(afterResume).toBe(resumed)

    const cleared = regenerateSessionId()
    const afterClear = await eventually(
      () => readJson(ownRecord).sessionId,
      id => id === cleared,
    )
    expect(afterClear).toBe(cleared)
  })

  test('once registration has run, whenSessionRegistered resolves true', async () => {
    await registerSession()

    expect(await whenSessionRegistered()).toBe(true)
  })
})

describe('registerSession — what only a fresh process shows', () => {
  test('whenSessionRegistered waits for the first attempt and keeps its outcome', async () => {
    const result = await runInFreshProcess(
      `
      const sessions = await load('src/sessions/concurrentSessions.ts')
      const team = await load('src/agent/coordinator/teammate.ts')
      const pending = await Promise.race([
        sessions.whenSessionRegistered().then(() => 'settled'),
        Bun.sleep(150).then(() => 'pending'),
      ])
      team.setDynamicTeamContext({ agentId: 'w', agentName: 'w', teamName: 't', planModeRequired: false })
      const skipped = await sessions.registerSession()
      const afterSkip = await sessions.whenSessionRegistered()
      team.clearDynamicTeamContext()
      const written = await sessions.registerSession()
      const afterWrite = await sessions.whenSessionRegistered()
      return { pending, skipped, afterSkip, written, afterWrite }
      `,
      { CLAUDIN_CONFIG_DIR: configDir },
      sandbox,
    )

    expect(result).toEqual({
      pending: 'pending',
      skipped: false,
      afterSkip: false,
      written: true,
      afterWrite: false,
    })
  })

  test('the graceful-shutdown cleanup removes the record', async () => {
    const result = await runInFreshProcess(
      `
      const { join } = await import('path')
      const { existsSync } = await import('fs')
      const sessions = await load('src/sessions/concurrentSessions.ts')
      const cleanup = await load('src/shared/cleanupRegistry.ts')
      const record = join(process.env.CLAUDIN_CONFIG_DIR, 'sessions', process.pid + '.json')
      const registered = await sessions.registerSession()
      const whileRunning = existsSync(record)
      await cleanup.runCleanupFunctions()
      return { registered, whileRunning, afterShutdown: existsSync(record) }
      `,
      { CLAUDIN_CONFIG_DIR: configDir },
      sandbox,
    )

    expect(result).toEqual({
      registered: true,
      whileRunning: true,
      afterShutdown: false,
    })
  })
})

describe('updating this session’s record', () => {
  beforeEach(async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    switchSession(asSessionId(randomUUID()))
    setOriginalCwd(sandbox)
    await registerSession()
  })

  test('each update merges its fields into the record and keeps the rest', async () => {
    await updateSessionName('Scout')
    await updateSessionBridgeId('bridge-42')
    await updateSessionInbox({
      messagingSocketPath: '/run/inbox.sock',
      messagingToken: 'secret-token',
    })
    await updateSessionCwd('/work/tree')
    await updateSessionStatus('busy')
    await updateSessionPresence({
      turnActive: true,
      runningAgents: 2,
      costUSD: 1.25,
    })

    expect(normalizeRecord(readJson(ownRecord), getSessionId())).toEqual(
      readFixture('pid-record.updated.json'),
    )
  })

  test('a bridge id and an inbox are withdrawn with nulls, which stay in the record', async () => {
    await updateSessionBridgeId('bridge-42')
    await updateSessionInbox({
      messagingSocketPath: '/run/inbox.sock',
      messagingToken: 'secret-token',
    })

    await updateSessionBridgeId(null)
    await updateSessionInbox({ messagingSocketPath: null, messagingToken: null })

    const record = readJson(ownRecord)
    expect(record.bridgeSessionId).toBeNull()
    expect(record.messagingSocketPath).toBeNull()
    expect(record.messagingToken).toBeNull()
  })

  test('status and presence overwrite their earlier values', async () => {
    await updateSessionStatus('busy')
    await updateSessionPresence({ turnActive: true, runningAgents: 3, costUSD: 2 })

    await updateSessionStatus('idle')
    await updateSessionPresence({ turnActive: false, runningAgents: 0, costUSD: 2.5 })

    expect(readJson(ownRecord)).toMatchObject({
      status: 'idle',
      turnActive: false,
      runningAgents: 0,
      costUSD: 2.5,
    })
  })

  test('an empty or missing name writes nothing', async () => {
    const untouched = readFileSync(ownRecord, 'utf8')

    await updateSessionName(undefined)
    await updateSessionName('')

    expect(readFileSync(ownRecord, 'utf8')).toBe(untouched)
  })

  test('updates fired together all land', async () => {
    await Promise.all([
      updateSessionName('Parallel'),
      updateSessionStatus('busy'),
      updateSessionCwd('/elsewhere'),
      updateSessionBridgeId('b-1'),
      updateSessionPresence({ turnActive: true, runningAgents: 1, costUSD: 0.5 }),
    ])

    expect(readJson(ownRecord)).toMatchObject({
      name: 'Parallel',
      status: 'busy',
      cwd: '/elsewhere',
      bridgeSessionId: 'b-1',
      turnActive: true,
      runningAgents: 1,
      costUSD: 0.5,
    })
  })

  test('the record stays owner-only after an update', async () => {
    await updateSessionInbox({
      messagingSocketPath: '/run/inbox.sock',
      messagingToken: 'secret-token',
    })

    expect(modeOf(ownRecord)).toBe(0o600)
  })

  test('with no record on disk an update resolves quietly and creates nothing', async () => {
    rmSync(ownRecord)

    await updateSessionName('Ghost')
    await updateSessionStatus('busy')
    await updateSessionCwd('/nowhere')

    expect(existsSync(ownRecord)).toBe(false)
  })
})

describe('countConcurrentSessions', () => {
  test('is 0 when no session has written a record yet', async () => {
    expect(await countConcurrentSessions()).toBe(0)
  })

  test('is 0 when the sessions path is not a directory', async () => {
    writeFileSync(sessionsDir, 'not a directory')

    expect(await countConcurrentSessions()).toBe(0)
  })

  test('counts this process and every live one, whatever their records hold', async () => {
    writeRecord(process.pid, 'not even json')
    writeRecord(spawnLiveProcess(), { sessionId: 'a' })
    writeRecord(spawnLiveProcess(), { sessionId: 'b' })

    expect(await countConcurrentSessions()).toBe(3)
  })

  test("sweeps the record of a process that is gone, and doesn't count it", async () => {
    writeRecord(spawnLiveProcess(), { sessionId: 'alive' })
    const stale = writeRecord(NEVER_A_PID, { sessionId: 'crashed' })

    expect(await countConcurrentSessions()).toBe(1)
    expect(await eventually(() => existsSync(stale), gone => !gone)).toBe(false)
  })

  test('ignores and keeps every file that is not exactly <digits>.json', async () => {
    const keep = [
      '2026-03-14_notes.json',
      `${NEVER_A_PID}.json.tmp`,
      `${NEVER_A_PID}.JSON`,
      'abc.json',
      `-${NEVER_A_PID}.json`,
    ].map(name => {
      mkdirSync(sessionsDir, { recursive: true })
      const path = join(sessionsDir, name)
      writeFileSync(path, '{}')
      return path
    })

    expect(await countConcurrentSessions()).toBe(0)
    await Bun.sleep(50)
    for (const path of keep) expect(existsSync(path)).toBe(true)
  })
})

describe('listLiveSessions — with the real process table', () => {
  test("lists other live sessions from this config dir, never this process's own", async () => {
    const live = spawnLiveProcess()
    writeRecord(live, { pid: live, sessionId: 'theirs', cwd: '/b', startedAt: 1 })
    writeRecord(process.pid, {
      pid: process.pid,
      sessionId: 'mine',
      cwd: '/a',
      startedAt: 1,
    })

    expect(await listLiveSessions()).toEqual([
      { pid: live, sessionId: 'theirs', cwd: '/b' },
    ])
  })

  test('leaves the record of a dead process where it is', async () => {
    const stale = writeRecord(NEVER_A_PID, {
      pid: NEVER_A_PID,
      sessionId: 'crashed',
      cwd: '/c',
      startedAt: 1,
    })

    expect(await listLiveSessions()).toEqual([])
    await Bun.sleep(50)
    expect(existsSync(stale)).toBe(true)
  })

  test('hands out only the identity and presence fields: no name, status, bridge id or inbox token', async () => {
    const live = spawnLiveProcess()
    writeRecord(live, {
      pid: live,
      sessionId: 'theirs',
      cwd: '/b',
      startedAt: 1,
      kind: 'interactive',
      name: 'Scout',
      status: 'busy',
      bridgeSessionId: 'bridge-1',
      messagingSocketPath: '/run/s.sock',
      messagingToken: 'secret-token',
      turnActive: false,
      runningAgents: 0,
      costUSD: 0,
    })

    expect(await listLiveSessions()).toEqual([
      {
        pid: live,
        sessionId: 'theirs',
        cwd: '/b',
        turnActive: false,
        runningAgents: 0,
        costUSD: 0,
      },
    ])
  })

  test('skips a record that is not JSON, or whose pid is not a whole number', async () => {
    const first = spawnLiveProcess()
    const second = spawnLiveProcess()
    writeRecord(first, '{"pid": ')
    writeRecord(second, { pid: 1.5, sessionId: 's', cwd: '/x' })

    expect(await listLiveSessions()).toEqual([])
  })

  test('skips a directory that is named like a record', async () => {
    mkdirSync(join(sessionsDir, `${spawnLiveProcess()}.json`), { recursive: true })

    expect(await listLiveSessions()).toEqual([])
  })
})
