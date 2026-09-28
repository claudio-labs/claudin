import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { listLiveSessions } from 'src/sessions/lifecycle/processRecord/liveSessions.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifecycle-live-sessions-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const deps = () => ({ sessionsDir: dir, ownPid: 1, isAlive: () => true })

test('a record whose presence field has the wrong type does not match, and is skipped', async () => {
  writeFileSync(join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'a', cwd: '/a', costUSD: '1.25' }))
  writeFileSync(join(dir, '300.json'), JSON.stringify({ pid: 300, sessionId: 'b', cwd: '/b', costUSD: 1.25 }))

  expect(await listLiveSessions(deps())).toEqual([{ pid: 300, sessionId: 'b', cwd: '/b', costUSD: 1.25 }])
})

test('the fields a record leaves out stay out of the listing', async () => {
  writeFileSync(join(dir, '200.json'), JSON.stringify({ pid: 200, sessionId: 'a', cwd: '/a' }))

  const [session] = await listLiveSessions(deps())

  expect(Object.keys(session ?? {}).sort()).toEqual(['cwd', 'pid', 'sessionId'])
})
