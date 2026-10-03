// Characterization of the session listings behind /resume (unit
// `sessions/indexingScan`, the cross-project half): the sessions of every
// worktree of the current repository, and the sessions of every project.
// Transcripts are real files in a fresh config home per test, with their
// modification times set so the order is known.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getStatOnlyLogsForWorktrees } from 'src/sessions/indexing/crossProject.js'
import {
  loadAllProjectsMessageLogs,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogs,
  loadSameRepoMessageLogsProgressive,
} from 'src/sessions/sessionStorage.js'
import { sanitizePath } from 'src/sessions/sessionStoragePortable.js'
import type { LogOption } from 'src/shared/types/logs.js'

const EPOCH = Date.UTC(2026, 8, 1, 12, 0, 0)
const sessionOf = (n: number) => `${(0xbeef0000 + n).toString(16)}-1b2c-4d3e-8f40-5a6b7c8d9e0f`

type SessionFile = {
  /** Session number; its id is `sessionOf(n)`. */
  n: number
  /** Minutes after EPOCH for the file's modification time. */
  minute: number
  prompt?: string
  cwd?: string
  sidechain?: boolean
  team?: string
  title?: string
}

let home: string
let savedCwd: string
let savedConfig: string | undefined
const projects = () => join(home, 'projects')

function writeSession(folder: string, s: SessionFile): string {
  const dir = join(projects(), folder)
  mkdirSync(dir, { recursive: true })
  const id = sessionOf(s.n)
  const first: Record<string, unknown> = { parentUuid: null, isSidechain: s.sidechain ?? false }
  if (s.team) first.teamName = s.team
  Object.assign(first, {
    type: 'user',
    message: { role: 'user', content: s.prompt ?? `prompt of session ${s.n}` },
    uuid: `0ddba11e-0000-4000-8000-${s.n.toString().padStart(12, '0')}`,
    timestamp: new Date(EPOCH + s.minute * 60_000).toISOString(),
    userType: 'external',
    cwd: s.cwd ?? `/work/session-${s.n}`,
    sessionId: id,
    version: '1.4.2',
    gitBranch: `branch-${s.n}`,
  })
  const lines = [JSON.stringify(first)]
  if (s.title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: s.title, sessionId: id }))
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n')
  const when = new Date(EPOCH + s.minute * 60_000)
  utimesSync(path, when, when)
  return path
}

const ids = (logs: LogOption[]) => logs.map(l => l.sessionId)
const values = (logs: LogOption[]) => logs.map(l => l.value)
const counting = (logs: LogOption[]) => logs.map((_, i) => i)

beforeEach(() => {
  savedCwd = getOriginalCwd()
  savedConfig = process.env.CLAUDIN_CONFIG_DIR
  home = mkdtempSync(join(tmpdir(), 'indexing-scan-cross-'))
  process.env.CLAUDIN_CONFIG_DIR = home
})

afterEach(() => {
  setOriginalCwd(savedCwd)
  if (savedConfig === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfig
  rmSync(home, { recursive: true, force: true })
})

describe('getStatOnlyLogsForWorktrees', () => {
  test('with one worktree or none, the original cwd is listed whatever path is passed', async () => {
    setOriginalCwd('/work/shop')
    writeSession(sanitizePath('/work/shop'), { n: 1, minute: 1 })
    writeSession(sanitizePath('/work/elsewhere'), { n: 2, minute: 2 })
    for (const worktrees of [[], ['/work/elsewhere']]) {
      const logs = await getStatOnlyLogsForWorktrees(worktrees)
      expect({ worktrees, ids: ids(logs) }).toEqual({ worktrees, ids: [sessionOf(1)] })
      expect(logs[0]!.projectPath).toBe('/work/shop')
    }
  })

  test('a listed session is a stat-only entry: nothing of the file is read', async () => {
    setOriginalCwd('/work/shop')
    const path = writeSession(sanitizePath('/work/shop'), { n: 4, minute: 7, title: 'kept unread' })
    const [log] = await getStatOnlyLogsForWorktrees(['/work/shop'])
    const modified = new Date(EPOCH + 7 * 60_000)
    expect(log).toEqual({
      date: modified.toISOString(),
      messages: [],
      isLite: true,
      fullPath: path,
      value: 0,
      created: statSync(path).birthtime,
      modified,
      firstPrompt: '',
      messageCount: 0,
      fileSize: statSync(path).size,
      isSidechain: false,
      sessionId: sessionOf(4),
      projectPath: '/work/shop',
    })
  })

  test('only <uuid>.jsonl files directly in the folder are sessions, newest first', async () => {
    setOriginalCwd('/work/shop')
    const folder = sanitizePath('/work/shop')
    writeSession(folder, { n: 1, minute: 1 })
    writeSession(folder, { n: 3, minute: 9 })
    writeSession(folder, { n: 2, minute: 5 })
    writeFileSync(join(projects(), folder, 'notes.jsonl'), '{}\n')
    writeFileSync(join(projects(), folder, `${sessionOf(8)}.json`), '{}\n')
    mkdirSync(join(projects(), folder, `${sessionOf(9)}.jsonl`))
    const logs = await getStatOnlyLogsForWorktrees([])
    expect(ids(logs)).toEqual([sessionOf(3), sessionOf(2), sessionOf(1)])
    expect(values(logs)).toEqual([0, 1, 2])
  })

  test('with several worktrees, each folder is matched to the longest worktree it belongs to', async () => {
    const worktrees = ['/repo/app', '/repo/app-hotfix', '/repo/app-hotfix-old']
    writeSession(sanitizePath('/repo/app'), { n: 1, minute: 1 })
    writeSession(sanitizePath('/repo/app/packages/api'), { n: 2, minute: 2 })
    writeSession(sanitizePath('/repo/app-hotfix'), { n: 3, minute: 3 })
    writeSession(sanitizePath('/repo/app-hotfix/src'), { n: 4, minute: 4 })
    writeSession(sanitizePath('/repo/app-hotfix-old'), { n: 5, minute: 5 })
    writeSession(sanitizePath('/repo/application'), { n: 6, minute: 6 })
    writeSession(sanitizePath('/repo'), { n: 7, minute: 7 })
    writeSession(sanitizePath('/other/app'), { n: 8, minute: 8 })
    const logs = await getStatOnlyLogsForWorktrees(worktrees)
    expect(logs.map(l => [l.sessionId, l.projectPath])).toEqual([
      [sessionOf(5), '/repo/app-hotfix-old'],
      [sessionOf(4), '/repo/app-hotfix'],
      [sessionOf(3), '/repo/app-hotfix'],
      [sessionOf(2), '/repo/app'],
      [sessionOf(1), '/repo/app'],
    ])
    expect(values(logs)).toEqual(counting(logs))
  })

  test('the order of the worktrees passed does not change the match', async () => {
    writeSession(sanitizePath('/repo/app-hotfix'), { n: 3, minute: 3 })
    const logs = await getStatOnlyLogsForWorktrees(['/repo/app', '/repo/app-hotfix'])
    const reversed = await getStatOnlyLogsForWorktrees(['/repo/app-hotfix', '/repo/app'])
    expect(logs.map(l => l.projectPath)).toEqual(['/repo/app-hotfix'])
    expect(reversed.map(l => l.projectPath)).toEqual(['/repo/app-hotfix'])
  })

  test('a session found in two worktree folders is listed once, from the newer file', async () => {
    writeSession(sanitizePath('/repo/app'), { n: 1, minute: 10 })
    const newer = writeSession(sanitizePath('/repo/app-wt'), { n: 1, minute: 20 })
    writeSession(sanitizePath('/repo/app'), { n: 2, minute: 15 })
    const logs = await getStatOnlyLogsForWorktrees(['/repo/app', '/repo/app-wt'])
    expect(logs.map(l => [l.sessionId, l.fullPath, l.value])).toEqual([
      [sessionOf(1), newer, 0],
      [sessionOf(2), join(projects(), sanitizePath('/repo/app'), `${sessionOf(2)}.jsonl`), 1],
    ])
  })

  test('with several worktrees and no projects folder, nothing is listed', async () => {
    setOriginalCwd('/repo/app')
    expect(await getStatOnlyLogsForWorktrees(['/repo/app', '/repo/app-wt'])).toEqual([])
  })

  test('folder names are matched case-sensitively, except on Windows', async () => {
    writeSession('c--Users-dev-shop', { n: 1, minute: 1 })
    const worktrees = ['C:\\Users\\dev\\shop', 'C:\\Users\\dev\\shop-wt']
    expect(await getStatOnlyLogsForWorktrees(worktrees)).toEqual([])
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const logs = await getStatOnlyLogsForWorktrees(worktrees)
      expect(logs.map(l => [l.sessionId, l.projectPath])).toEqual([[sessionOf(1), 'C:\\Users\\dev\\shop']])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})

describe('loadSameRepoMessageLogs', () => {
  const plainAt = (n: number, minute: number): SessionFile => ({ n, minute })

  test('the newest sessions are read for their titles, sidechains and team sessions are skipped', async () => {
    setOriginalCwd('/repo/app')
    const folder = sanitizePath('/repo/app')
    writeSession(folder, { n: 1, minute: 50, sidechain: true })
    writeSession(folder, { n: 2, minute: 40, prompt: 'Fix the flaky login test', cwd: '/repo/app/web', title: 'login flake' })
    writeSession(folder, { n: 3, minute: 30, team: 'payments' })
    writeSession(folder, { n: 4, minute: 20, prompt: 'Bump the lockfile' })
    writeSession(folder, { n: 5, minute: 10 })

    const result = await loadSameRepoMessageLogsProgressive(['/repo/app'], undefined, 2)
    expect(ids(result.allStatLogs)).toEqual([1, 2, 3, 4, 5].map(sessionOf))
    expect(result.allStatLogs.every(l => l.isLite)).toBe(true)
    expect(result.nextIndex).toBe(4)
    expect(result.logs.map(l => [l.sessionId, l.value, l.isLite, l.firstPrompt, l.customTitle, l.gitBranch, l.projectPath])).toEqual([
      [sessionOf(2), 0, false, 'Fix the flaky login test', 'login flake', 'branch-2', '/repo/app/web'],
      [sessionOf(4), 1, false, 'Bump the lockfile', undefined, 'branch-4', '/work/session-4'],
    ])
    expect(await loadSameRepoMessageLogs(['/repo/app'], undefined, 2)).toEqual(result.logs)
  })

  test('loading continues from nextIndex where the first pass stopped', async () => {
    setOriginalCwd('/repo/app')
    for (let n = 1; n <= 4; n++) writeSession(sanitizePath('/repo/app'), plainAt(n, 10 * n))
    const first = await loadSameRepoMessageLogsProgressive(['/repo/app'], undefined, 3)
    expect(ids(first.logs)).toEqual([4, 3, 2].map(sessionOf))
    expect(first.nextIndex).toBe(3)
  })

  test('fifty sessions are read when no count is given', async () => {
    setOriginalCwd('/repo/app')
    for (let n = 1; n <= 52; n++) writeSession(sanitizePath('/repo/app'), plainAt(n, n))
    const result = await loadSameRepoMessageLogsProgressive(['/repo/app'])
    expect(result.logs).toHaveLength(50)
    expect(result.nextIndex).toBe(50)
    expect(result.allStatLogs).toHaveLength(52)
    expect(values(result.logs)).toEqual(counting(result.logs))
    expect(await loadSameRepoMessageLogs(['/repo/app'])).toHaveLength(50)
  })

  test('several worktrees are listed together', async () => {
    writeSession(sanitizePath('/repo/app'), plainAt(1, 1))
    writeSession(sanitizePath('/repo/app-wt'), plainAt(2, 2))
    writeSession(sanitizePath('/repo/other'), plainAt(3, 3))
    const logs = await loadSameRepoMessageLogs(['/repo/app', '/repo/app-wt'])
    expect(ids(logs)).toEqual([sessionOf(2), sessionOf(1)])
  })
})

describe('loadAllProjectsMessageLogs', () => {
  test('every project folder is listed, a session in two folders once, from the newer file', async () => {
    writeSession(sanitizePath('/repo/app'), { n: 1, minute: 10 })
    writeSession(sanitizePath('/repo/app'), { n: 2, minute: 30, sidechain: true })
    const newer = writeSession(sanitizePath('/elsewhere/tool'), { n: 1, minute: 40, prompt: 'Newer copy' })
    writeSession(sanitizePath('/elsewhere/tool'), { n: 3, minute: 20, prompt: 'Profile the parser' })
    mkdirSync(projects(), { recursive: true })
    writeFileSync(join(projects(), 'stray.jsonl'), '{}\n')

    const result = await loadAllProjectsMessageLogsProgressive()
    expect(ids(result.allStatLogs)).toEqual([1, 2, 3].map(sessionOf))
    expect(values(result.allStatLogs)).toEqual([0, 1, 2])
    expect(result.nextIndex).toBe(3)
    expect(result.logs.map(l => [l.sessionId, l.value, l.fullPath, l.firstPrompt])).toEqual([
      [sessionOf(1), 0, newer, 'Newer copy'],
      [sessionOf(3), 1, join(projects(), sanitizePath('/elsewhere/tool'), `${sessionOf(3)}.jsonl`), 'Profile the parser'],
    ])
    expect(await loadAllProjectsMessageLogs()).toEqual(result.logs)
  })

  test('a limit keeps the newest sessions of each folder', async () => {
    for (const [folder, base] of [['/a', 0], ['/b', 10]] as const) {
      for (let k = 1; k <= 3; k++) writeSession(sanitizePath(folder), { n: base + k, minute: base + k })
    }
    const result = await loadAllProjectsMessageLogsProgressive(2)
    expect(ids(result.allStatLogs)).toEqual([13, 12, 3, 2].map(sessionOf))
    expect(ids(await loadAllProjectsMessageLogs(2))).toEqual([13, 12, 3, 2].map(sessionOf))
  })

  test('the number of sessions read can be given, fifty when it is not', async () => {
    for (let n = 1; n <= 52; n++) writeSession(sanitizePath(`/p/${n % 3}`), { n, minute: n })
    const two = await loadAllProjectsMessageLogsProgressive(undefined, 2)
    expect(ids(two.logs)).toEqual([52, 51].map(sessionOf))
    expect(two.nextIndex).toBe(2)
    expect(ids(await loadAllProjectsMessageLogs(undefined, { initialEnrichCount: 2 }))).toEqual([52, 51].map(sessionOf))
    const byDefault = await loadAllProjectsMessageLogsProgressive()
    expect(byDefault.logs).toHaveLength(50)
    expect(byDefault.nextIndex).toBe(50)
    expect(await loadAllProjectsMessageLogs()).toHaveLength(50)
  })

  test('without a projects folder, nothing is listed', async () => {
    expect(await loadAllProjectsMessageLogsProgressive()).toEqual({ logs: [], allStatLogs: [], nextIndex: 0 })
    expect(await loadAllProjectsMessageLogs()).toEqual([])
  })
})
