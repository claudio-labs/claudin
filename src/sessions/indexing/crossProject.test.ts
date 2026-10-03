// Unit tests for the listing fix decision of the spec: `limit` keeps the newest
// sessions of each folder in the same-repository listing too.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import {
  getStatOnlyLogsForWorktrees,
  loadSameRepoMessageLogsProgressive,
} from 'src/sessions/indexing/crossProject.js'
import { sanitizePath } from 'src/sessions/sessionStoragePortable.js'

const EPOCH = Date.UTC(2026, 9, 1, 8, 0, 0)
const sessionOf = (n: number) => `${(0xcafe0000 + n).toString(16)}-2c3d-4e5f-8a6b-7c8d9e0f1a2b`

let home: string
let savedCwd: string
let savedConfig: string | undefined

function writeSession(project: string, n: number): void {
  const dir = join(home, 'projects', sanitizePath(project))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionOf(n)}.jsonl`)
  writeFileSync(path, `${JSON.stringify({ type: 'user', message: { content: `session ${n}` }, sessionId: sessionOf(n) })}\n`)
  const when = new Date(EPOCH + n * 60_000)
  utimesSync(path, when, when)
}

beforeEach(() => {
  savedCwd = getOriginalCwd()
  savedConfig = process.env.CLAUDIN_CONFIG_DIR
  home = mkdtempSync(join(tmpdir(), 'cross-project-unit-'))
  process.env.CLAUDIN_CONFIG_DIR = home
  setOriginalCwd('/repo/app')
})

afterEach(() => {
  setOriginalCwd(savedCwd)
  if (savedConfig === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfig
  rmSync(home, { recursive: true, force: true })
})

describe('the same-repository listing honours limit per folder', () => {
  const cases = [
    { name: 'one worktree', worktrees: ['/repo/app'], expected: [3, 2] },
    { name: 'several worktrees', worktrees: ['/repo/app', '/repo/app-wt'], expected: [13, 12, 3, 2] },
  ]
  for (const { name, worktrees, expected } of cases) {
    test(name, async () => {
      for (const n of [1, 2, 3]) writeSession('/repo/app', n)
      for (const n of [11, 12, 13]) writeSession('/repo/app-wt', n)
      const logs = await getStatOnlyLogsForWorktrees(worktrees, 2)
      expect(logs.map(l => l.sessionId)).toEqual(expected.map(sessionOf))
      expect(logs.map(l => l.value)).toEqual(expected.map((_, i) => i))
    })
  }

  test('the progressive listing passes it through', async () => {
    for (const n of [1, 2, 3]) writeSession('/repo/app', n)
    const result = await loadSameRepoMessageLogsProgressive(['/repo/app'], 1, 5)
    expect(result.allStatLogs.map(l => l.sessionId)).toEqual([sessionOf(3)])
    expect(result.nextIndex).toBe(1)
  })
})
