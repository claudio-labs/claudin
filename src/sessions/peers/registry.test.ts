import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  type DirectoryDeps,
  type PeerSession,
  readSessionDirectory,
  resolvePeerTarget,
} from 'src/sessions/peers/registry.js'

let dir: string
const OWN_PID = 100

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-registry-'))
  const write = (pid: number, record: Record<string, unknown>) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, ...record }))
  write(OWN_PID, { cwd: '/w/claudin', startedAt: 1, messagingSocketPath: '/s/100.sock', messagingToken: 't0' })
  write(201, { cwd: '/w/claudin-goal', startedAt: 30, messagingSocketPath: '/s/201.sock', messagingToken: 't1', status: 'idle' })
  write(202, { cwd: '/w/claudin-loop', startedAt: 20, name: 'looper', messagingSocketPath: '/s/202.sock', messagingToken: 't2' })
  write(203, { cwd: '/w/dead', startedAt: 5, messagingSocketPath: '/s/203.sock', messagingToken: 't3' })
  write(204, { cwd: '/w/headless', startedAt: 6 })
  write(205, { cwd: '/w/spoofed', startedAt: 7, messagingSocketPath: '/var/run/docker.sock', messagingToken: 't5' })
  write(206, { cwd: '/w/unresponsive', startedAt: 8, messagingSocketPath: '/s/206.sock', messagingToken: 't6' })
  writeFileSync(join(dir, '2026-09-24_notes.json'), '{}')
  writeFileSync(join(dir, '207.json'), '{ torn')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(): DirectoryDeps {
  return {
    sessionsDir: dir,
    ownPid: OWN_PID,
    ownCwd: '/w/claudin',
    isAlive: pid => pid !== 203,
    isOwnedSocket: async path => path.startsWith('/s/'),
    ping: async socketPath => socketPath !== '/s/206.sock',
  }
}

describe('readSessionDirectory', () => {
  test('lists live sessions with an inbox this user owns, oldest first', async () => {
    const { self, peers } = await readSessionDirectory({}, deps())
    expect(peers.map(p => [p.pid, p.name, p.status])).toEqual([
      [206, 'unresponsive', undefined],
      [202, 'looper', undefined],
      [201, 'claudin-goal', 'idle'],
    ])
    expect(self.name).toBe('claudin')
    const refs = [self.ref, ...peers.map(p => p.ref)]
    expect(new Set(refs).size).toBe(refs.length)
    for (const ref of refs) expect(ref).toMatch(/^[0-9a-f]{6,12}$/)
  })

  test('a probe drops a session whose inbox does not answer', async () => {
    const { peers } = await readSessionDirectory({ probe: true }, deps())
    expect(peers.map(p => p.pid)).toEqual([202, 201])
  })

  test('with no record of its own, the session is named after its directory', async () => {
    const { self } = await readSessionDirectory({}, { ...deps(), ownPid: 999 })
    expect(self).toEqual({ name: 'claudin', ref: undefined })
  })
})

describe('resolvePeerTarget', () => {
  const peer = (name: string, hash: string, socketPath: string): PeerSession => ({
    pid: 1,
    name,
    hash,
    ref: hash.slice(0, 6),
    socketPath,
    token: 't',
    cwd: '/w',
    startedAt: 0,
  })
  const peers = [
    peer('claudin-goal', 'aaaaaa11', '/s/1.sock'),
    peer('twin', 'bbbbbb11', '/s/2.sock'),
    peer('twin', 'cccccc11', '/s/3.sock'),
  ]

  test('a bare name, a name with its ref, and a from address all resolve', () => {
    expect(resolvePeerTarget('claudin-goal', peers)).toEqual({ peer: peers[0]! })
    expect(resolvePeerTarget('twin [cccccc]', peers)).toEqual({ peer: peers[2]! })
    expect(resolvePeerTarget('uds:/s/2.sock', peers)).toEqual({ peer: peers[1]! })
  })

  test('an ambiguous name asks for a ref and lists them', () => {
    const resolution = resolvePeerTarget('twin', peers)
    expect('error' in resolution && resolution.error).toContain('"twin [bbbbbb]", "twin [cccccc]"')
  })

  test('an address no session advertises is refused, never dialled', () => {
    const resolution = resolvePeerTarget('uds:/var/run/docker.sock', peers)
    expect('error' in resolution && resolution.error).toContain('No session is listening')
  })

  test('a stale ref is refused; an unknown bare name is handed back', () => {
    expect('error' in resolvePeerTarget('twin [dddddd]', peers)).toBe(true)
    expect(resolvePeerTarget('researcher', peers)).toEqual({ notAPeer: true })
  })
})
