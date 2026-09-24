import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { patchPidRecord, writePidRecord } from 'src/sessions/pidRecord.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pid-record-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

test('a record is written owner-only', async () => {
  const file = join(dir, '1.json')
  await writePidRecord(file, { pid: 1 })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(read(file)).toEqual({ pid: 1 })
})

test('patches issued together all land', async () => {
  const file = join(dir, '2.json')
  await writePidRecord(file, { pid: 2 })
  await Promise.all([
    patchPidRecord(file, { name: 'claudin-goal' }),
    patchPidRecord(file, { messagingSocketPath: '/s/2.sock', messagingToken: 't' }),
    patchPidRecord(file, { status: 'busy' }),
  ])
  expect(read(file)).toEqual({
    pid: 2,
    name: 'claudin-goal',
    messagingSocketPath: '/s/2.sock',
    messagingToken: 't',
    status: 'busy',
  })
})

test('a failed patch rejects without stalling the next one', async () => {
  const file = join(dir, '3.json')
  const failed = patchPidRecord(join(dir, 'missing.json'), { name: 'x' })
  await writePidRecord(file, { pid: 3 })
  const next = patchPidRecord(file, { name: 'ok' })
  await expect(failed).rejects.toThrow()
  await next
  expect(read(file)).toEqual({ pid: 3, name: 'ok' })
})
