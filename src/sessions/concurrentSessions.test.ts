import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listLiveSessions } from 'src/sessions/concurrentSessions.js'

describe('listLiveSessions', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function record(pid: number, body: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir!, `${pid}.json`), JSON.stringify({ pid, ...body }))
  }

  test("lists other live processes' sessions, with or without an inbox", async () => {
    dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    await record(100, { sessionId: 'own', cwd: '/a', startedAt: 1, kind: 'interactive' })
    await record(200, { sessionId: 'alive', cwd: '/b', startedAt: 1, kind: 'interactive' })
    await record(300, {
      sessionId: 'alive-inbox',
      cwd: '/c',
      startedAt: 1,
      kind: 'interactive',
      messagingSocketPath: '/tmp/s.sock',
      messagingToken: 't',
    })
    await record(400, { sessionId: 'dead', cwd: '/d', startedAt: 1, kind: 'interactive' })
    await writeFile(join(dir, 'notes.json'), '{}')

    const live = await listLiveSessions({
      sessionsDir: dir,
      ownPid: 100,
      isAlive: pid => pid !== 400,
    })

    expect(live.map(s => s.sessionId).sort()).toEqual(['alive', 'alive-inbox'])
    expect(live.find(s => s.sessionId === 'alive')).toEqual({ pid: 200, sessionId: 'alive', cwd: '/b' })
  })

  test("carries what the other instance publishes about its session's work", async () => {
    dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    await record(200, { sessionId: 'busy', cwd: '/b', turnActive: true, runningAgents: 2, costUSD: 1.25 })
    const live = await listLiveSessions({ sessionsDir: dir, ownPid: 1, isAlive: () => true })
    expect(live).toEqual([{ pid: 200, sessionId: 'busy', cwd: '/b', turnActive: true, runningAgents: 2, costUSD: 1.25 }])
  })

  test('skips a record without a sessionId and a missing directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    await record(200, { cwd: '/b' })
    const deps = { sessionsDir: dir, ownPid: 1, isAlive: () => true }
    expect(await listLiveSessions(deps)).toEqual([])
    expect(await listLiveSessions({ ...deps, sessionsDir: join(dir, 'nope') })).toEqual([])
  })
})
