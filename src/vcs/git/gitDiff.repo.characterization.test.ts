/**
 * Characterization of the git-running half of src/vcs/git/gitDiff.ts
 * (fetchGitDiff, fetchGitDiffHunks, fetchDiffStatSummary), pinned before the
 * clean-base rewrite. docs/tech/rewrite/vcs/gitDiff.md is the spec.
 *
 * Every test builds real repositories in its own temp directory. git is cut
 * off from the machine's configuration (GIT_CONFIG_GLOBAL=/dev/null,
 * GIT_CONFIG_NOSYSTEM=1, HOME and CLAUDIN_CONFIG_DIR in the suite's temp root).
 *
 * Two ways in:
 * - With an explicit repository root, in this process.
 * - Without a root, in a fresh `bun` process whose working directory is the
 *   repository. Those calls go through process-wide caches (is the session in
 *   a repository, HEAD, the default branch) that last as long as the process
 *   and that nothing resets, so each case gets a process of its own. Calling
 *   them here would also leave those caches set for every later suite in the
 *   run. A break-probe still reaches them: the child imports the module file
 *   from disk.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fetchGitDiff, fetchGitDiffHunks } from 'src/vcs/git/gitDiff.js'

const GIT_TIMEOUT = 60_000
const ENV_KEYS = ['HOME', 'CLAUDIN_CONFIG_DIR', 'CLAUDIN_BASE_REF', 'CLAUDIN_DIAGNOSTICS_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES'] as const
const AUTHOR = { GIT_AUTHOR_NAME: 'Char Suite', GIT_AUTHOR_EMAIL: 'char@example.invalid', GIT_COMMITTER_NAME: 'Char Suite', GIT_COMMITTER_EMAIL: 'char@example.invalid' }
const EMPTY_SUMMARY = { uncommitted: null, branch: null, branchBase: null }

const savedEnv = new Map<string, string | undefined>()
let suiteRoot = ''
let scratch = ''

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitdiff-repo-char-')))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.HOME = join(suiteRoot, 'home')
  process.env.CLAUDIN_CONFIG_DIR = join(suiteRoot, 'config')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  mkdirSync(process.env.HOME)
  mkdirSync(process.env.CLAUDIN_CONFIG_DIR)
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(suiteRoot, { recursive: true, force: true })
})

beforeEach(() => {
  scratch = mkdtempSync(join(suiteRoot, 'case-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// ── building repositories ────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, ...AUTHOR },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** For the commands that are meant to stop half-way on a conflict. */
function gitStoppingOnConflict(dir: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd: dir, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' })
  expect(run.status).not.toBe(0)
}

function put(dir: string, path: string, content: string | Uint8Array): void {
  const file = join(dir, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function snapshot(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--no-verify', '-m', message)
}

function newRepo(name = 'repo', branch = 'main'): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', branch)
  return dir
}

const numbered = (count: number, text: (i: number) => string) => Array.from({ length: count }, (_, i) => text(i)).join('')
const pad = (i: number, width = 2) => String(i).padStart(width, '0')

/**
 * One of each change the reviewer has to show: an unstaged edit, a staged new
 * file, a deletion, a plain and a brace rename, a binary edit, a mode change,
 * an untracked file in a subdirectory and an ignored one.
 */
function repoWithEveryKindOfChange(): string {
  const dir = newRepo()
  put(dir, 'edited.txt', 'alpha\nbeta\ngamma\n')
  put(dir, 'gone.txt', 'to be removed\n')
  put(dir, 'old-name.txt', 'moved as is\nno edits here\n')
  put(dir, 'pkg/a/mod.ts', 'export const answer = 42\n')
  put(dir, 'blob.bin', new Uint8Array([0, 1, 2, 3, 250]))
  put(dir, 'mode.sh', '#!/bin/sh\necho mode\n')
  put(dir, '.gitignore', '*.log\n')
  snapshot(dir, 'base')
  put(dir, 'edited.txt', 'alpha\nBETA\ngamma\n')
  put(dir, 'staged.txt', 'fresh\nfile\n')
  git(dir, 'add', 'staged.txt')
  git(dir, 'rm', '-q', 'gone.txt')
  git(dir, 'mv', 'old-name.txt', 'new-name.txt')
  mkdirSync(join(dir, 'pkg/b'))
  git(dir, 'mv', 'pkg/a/mod.ts', 'pkg/b/mod.ts')
  put(dir, 'blob.bin', new Uint8Array([0, 1, 2, 3, 251, 9]))
  chmodSync(join(dir, 'mode.sh'), 0o755)
  put(dir, 'notes/untracked.txt', 'not added\n')
  put(dir, 'debug.log', 'ignored by .gitignore\n')
  return dir
}

/** main and side both rewrite the one line of shared.txt. */
function repoWithConflictingBranches(): string {
  const dir = newRepo()
  put(dir, 'shared.txt', 'base\n')
  snapshot(dir, 'base')
  git(dir, 'checkout', '-q', '-b', 'side')
  put(dir, 'shared.txt', 'side\n')
  snapshot(dir, 'side')
  git(dir, 'checkout', '-q', 'main')
  put(dir, 'shared.txt', 'main\n')
  snapshot(dir, 'main')
  return dir
}

// ── reading results ──────────────────────────────────────────────────────

/** Maps become entry lists, so results compare in order and survive JSON. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([key, item]) => [key, plain(item)])
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  }
  return value
}

/**
 * The old parser ends the last hunk of each file with one surplus "" (see the
 * parser suite); compare hunks the way their headers count them.
 */
function counted(hunks: Map<string, { oldLines: number; lines: string[] }[]>): Map<string, unknown[]> {
  return new Map(
    [...hunks].map(([path, list]) => [
      path,
      list.map(h => {
        const lines = [...h.lines]
        const oldSide = () => lines.filter(line => line === '' || line.startsWith(' ') || line.startsWith('-')).length
        while (lines.at(-1) === '' && oldSide() > h.oldLines) lines.pop()
        return { ...h, lines }
      }),
    ]),
  )
}

const UNIT_FILE = Bun.resolveSync('src/vcs/git/gitDiff.js', import.meta.dir)
type RootlessCall = 'fetchGitDiff' | 'fetchGitDiffHunks' | 'fetchDiffStatSummary'

/** Runs one root-less export in a new process started inside `dir`. */
function inFreshProcess(dir: string, call: RootlessCall, extraEnv: Record<string, string> = {}): unknown {
  const program = [
    `const unit = await import(${JSON.stringify(UNIT_FILE)})`,
    'const toPlain = v => v instanceof Map ? [...v].map(([k, x]) => [k, toPlain(x)]) : Array.isArray(v) ? v.map(toPlain) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)])) : v',
    `process.stdout.write(JSON.stringify(toPlain(await unit.${call}())))`,
    'process.exit(0)',
  ].join('\n')
  const run = spawnSync(process.execPath, ['-e', program], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      HOME: process.env.HOME ?? '',
      CLAUDIN_CONFIG_DIR: process.env.CLAUDIN_CONFIG_DIR ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
  })
  if (run.status !== 0) throw new Error(`${call} in a fresh process exited ${run.status}: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

// ── fetchGitDiff ─────────────────────────────────────────────────────────

describe('fetchGitDiff(root): per-file numbers for the working tree and index against HEAD', () => {
  test('every kind of change, then the untracked files; ignored files are left out and hunks are never filled', async () => {
    const dir = repoWithEveryKindOfChange()
    const result = await fetchGitDiff(dir)
    expect(result).not.toBeNull()
    expect(result!.stats).toStrictEqual({ filesCount: 8, linesAdded: 3, linesRemoved: 2 })
    expect(plain(result!.perFileStats)).toStrictEqual([
      ['blob.bin', { added: 0, removed: 0, isBinary: true }],
      ['edited.txt', { added: 1, removed: 1, isBinary: false }],
      ['gone.txt', { added: 0, removed: 1, isBinary: false }],
      ['mode.sh', { added: 0, removed: 0, isBinary: false }],
      ['new-name.txt', { added: 0, removed: 0, isBinary: false, renamedFrom: 'old-name.txt' }],
      ['pkg/b/mod.ts', { added: 0, removed: 0, isBinary: false, renamedFrom: 'pkg/a/mod.ts' }],
      ['staged.txt', { added: 2, removed: 0, isBinary: false }],
      ['notes/untracked.txt', { added: 0, removed: 0, isBinary: false, isUntracked: true }],
    ])
    expect(result!.hunks.size).toBe(0)
  }, GIT_TIMEOUT)

  test('a clean repository is all zeros, not null', async () => {
    const dir = newRepo()
    put(dir, 'readme.txt', 'hello\n')
    snapshot(dir, 'base')
    expect(plain(await fetchGitDiff(dir))).toStrictEqual({ stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 }, perFileStats: [], hunks: [] })
  }, GIT_TIMEOUT)

  test('a repository with no commit yet, or a directory outside any repository, is null', async () => {
    const unborn = newRepo('unborn')
    put(unborn, 'staged.txt', 'staged before the first commit\n')
    git(unborn, 'add', 'staged.txt')
    put(unborn, 'loose.txt', 'untracked\n')
    expect(await fetchGitDiff(unborn)).toBeNull()
    const outside = join(scratch, 'not-a-repo')
    mkdirSync(outside)
    put(outside, 'file.txt', 'text\n')
    expect(await fetchGitDiff(outside)).toBeNull()
  }, GIT_TIMEOUT)

  test('50 entries at most: the first 50 files in git order, with the totals over all of them', async () => {
    const dir = newRepo()
    for (let i = 0; i < 3; i++) put(dir, `a-bin-${i}.bin`, new Uint8Array([0, i, 7]))
    for (let i = 0; i < 55; i++) put(dir, `f-${pad(i)}.txt`, 'v1\n')
    snapshot(dir, 'base')
    for (let i = 0; i < 3; i++) put(dir, `a-bin-${i}.bin`, new Uint8Array([0, i, 8]))
    for (let i = 0; i < 55; i++) put(dir, `f-${pad(i)}.txt`, 'v2\n')
    const result = (await fetchGitDiff(dir))!
    expect(result.stats).toStrictEqual({ filesCount: 58, linesAdded: 55, linesRemoved: 55 })
    const keys = [...result.perFileStats.keys()]
    expect(keys).toHaveLength(50)
    expect(keys.slice(0, 4)).toEqual(['a-bin-0.bin', 'a-bin-1.bin', 'a-bin-2.bin', 'f-00.txt'])
    expect(keys.at(-1)).toBe('f-46.txt')
  }, GIT_TIMEOUT)

  test('untracked files only fill the entries the tracked ones left free, in name order', async () => {
    const dir = newRepo()
    for (let i = 0; i < 48; i++) put(dir, `t-${pad(i)}.txt`, 'v1\n')
    snapshot(dir, 'base')
    for (let i = 0; i < 48; i++) put(dir, `t-${pad(i)}.txt`, 'v2\n')
    for (let i = 4; i >= 0; i--) put(dir, `u-${i}.txt`, 'new\n')
    const result = (await fetchGitDiff(dir))!
    expect(result.perFileStats.size).toBe(50)
    expect(plain([...result.perFileStats].slice(47))).toStrictEqual([
      ['t-47.txt', { added: 1, removed: 1, isBinary: false }],
      ['u-0.txt', { added: 0, removed: 0, isBinary: false, isUntracked: true }],
      ['u-1.txt', { added: 0, removed: 0, isBinary: false, isUntracked: true }],
    ])
  }, GIT_TIMEOUT)

  test('more than 500 changed files: git\'s totals only, with no per-file detail', async () => {
    const dir = newRepo()
    for (let i = 0; i < 501; i++) put(dir, `n-${pad(i, 3)}.txt`, 'v1\n')
    snapshot(dir, 'base')
    for (let i = 0; i < 501; i++) put(dir, `n-${pad(i, 3)}.txt`, 'v2\n')
    expect(plain(await fetchGitDiff(dir))).toStrictEqual({ stats: { filesCount: 501, linesAdded: 501, linesRemoved: 501 }, perFileStats: [], hunks: [] })
  }, GIT_TIMEOUT)

  test('exactly 500 changed files still get per-file detail', async () => {
    const dir = newRepo()
    for (let i = 0; i < 500; i++) put(dir, `n-${pad(i, 3)}.txt`, 'v1\n')
    snapshot(dir, 'base')
    for (let i = 0; i < 500; i++) put(dir, `n-${pad(i, 3)}.txt`, 'v2\n')
    const result = (await fetchGitDiff(dir))!
    expect(result.stats).toStrictEqual({ filesCount: 500, linesAdded: 500, linesRemoved: 500 })
    expect(result.perFileStats.size).toBe(50)
  }, GIT_TIMEOUT)
})

// ── fetchGitDiffHunks ────────────────────────────────────────────────────

describe('fetchGitDiffHunks(root): the hunks of the working tree and index against HEAD', () => {
  const EVERY_KIND_HUNKS = [
    ['edited.txt', [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' alpha', '-beta', '+BETA', ' gamma'] }]],
    ['gone.txt', [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-to be removed'] }]],
    ['staged.txt', [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+fresh', '+file'] }]],
  ]

  test('staged and unstaged content changes; no entry for binaries, mode changes, pure renames or untracked files', async () => {
    const dir = repoWithEveryKindOfChange()
    expect(plain(counted(await fetchGitDiffHunks(dir)))).toStrictEqual(EVERY_KIND_HUNKS)
  }, GIT_TIMEOUT)

  test.each([
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
  ])('the repository setting %s=%s changes nothing: the a/ b/ prefixes are forced', async (key, value) => {
    const dir = repoWithEveryKindOfChange()
    git(dir, 'config', key, value)
    expect(plain(counted(await fetchGitDiffHunks(dir)))).toStrictEqual(EVERY_KIND_HUNKS)
  }, GIT_TIMEOUT)

  test('400 lines per file: a hunk is cut there and the hunks after it stay, with no lines', async () => {
    const dir = newRepo()
    put(dir, 'long.txt', numbered(1000, i => `line ${i + 1}\n`))
    snapshot(dir, 'base')
    put(dir, 'long.txt', numbered(1000, i => (i < 250 || i === 899 ? `LINE ${i + 1}\n` : `line ${i + 1}\n`)))
    const [first, second, ...more] = (await fetchGitDiffHunks(dir)).get('long.txt')!
    expect(more).toEqual([])
    expect({ ...first!, lines: first!.lines.length }).toStrictEqual({ oldStart: 1, oldLines: 253, newStart: 1, newLines: 253, lines: 400 })
    expect(first!.lines[0]).toBe('-line 1')
    expect(first!.lines[250]).toBe('+LINE 1')
    expect(first!.lines[399]).toBe('+LINE 150')
    expect(second).toStrictEqual({ oldStart: 897, oldLines: 7, newStart: 897, newLines: 7, lines: [] })
  }, GIT_TIMEOUT)

  test('only the first 50 files that have hunks are kept; binary files do not count toward them', async () => {
    const dir = newRepo()
    for (let i = 0; i < 3; i++) put(dir, `a-bin-${i}.bin`, new Uint8Array([0, i, 7]))
    for (let i = 0; i < 55; i++) put(dir, `f-${pad(i)}.txt`, 'v1\n')
    snapshot(dir, 'base')
    for (let i = 0; i < 3; i++) put(dir, `a-bin-${i}.bin`, new Uint8Array([0, i, 8]))
    for (let i = 0; i < 55; i++) put(dir, `f-${pad(i)}.txt`, 'v2\n')
    const keys = [...(await fetchGitDiffHunks(dir)).keys()]
    expect(keys).toEqual(Array.from({ length: 50 }, (_, i) => `f-${pad(i)}.txt`))
  }, GIT_TIMEOUT)

  test('git output above 1,000,000 bytes yields no hunks at all, while the numbers still come back', async () => {
    const dir = newRepo()
    put(dir, 'huge.txt', '')
    put(dir, 'small.txt', 'before\n')
    snapshot(dir, 'base')
    put(dir, 'small.txt', 'after\n')
    put(dir, 'huge.txt', numbered(15_000, i => `${'x'.repeat(46)} ${pad(i, 5)}\n`))
    expect([...(await fetchGitDiffHunks(dir)).keys()]).toEqual(['huge.txt', 'small.txt'])
    put(dir, 'huge.txt', numbered(25_000, i => `${'x'.repeat(46)} ${pad(i, 5)}\n`))
    expect((await fetchGitDiffHunks(dir)).size).toBe(0)
    expect(plain((await fetchGitDiff(dir))!.perFileStats)).toStrictEqual([
      ['huge.txt', { added: 25_000, removed: 0, isBinary: false }],
      ['small.txt', { added: 1, removed: 1, isBinary: false }],
    ])
  }, GIT_TIMEOUT)

  test('no commit yet, or not a repository: an empty map', async () => {
    const unborn = newRepo('unborn')
    put(unborn, 'staged.txt', 'staged\n')
    git(unborn, 'add', 'staged.txt')
    expect((await fetchGitDiffHunks(unborn)).size).toBe(0)
    const outside = join(scratch, 'not-a-repo')
    mkdirSync(outside)
    expect((await fetchGitDiffHunks(outside)).size).toBe(0)
  }, GIT_TIMEOUT)
})

// ── merge, rebase, cherry-pick and revert in progress ────────────────────

describe('while git is half-way through a merge, rebase, cherry-pick or revert: nothing', () => {
  async function expectNothing(dir: string): Promise<void> {
    expect(await fetchGitDiff(dir)).toBeNull()
    expect((await fetchGitDiffHunks(dir)).size).toBe(0)
  }

  test('a merge stopped on a conflict (MERGE_HEAD); after --abort the diff is back', async () => {
    const dir = repoWithConflictingBranches()
    gitStoppingOnConflict(dir, 'merge', 'side')
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true)
    await expectNothing(dir)
    git(dir, 'merge', '--abort')
    expect((await fetchGitDiff(dir))?.stats).toStrictEqual({ filesCount: 0, linesAdded: 0, linesRemoved: 0 })
  }, GIT_TIMEOUT)

  test('a rebase stopped on a conflict (REBASE_HEAD)', async () => {
    const dir = repoWithConflictingBranches()
    git(dir, 'checkout', '-q', 'side')
    gitStoppingOnConflict(dir, 'rebase', 'main')
    expect(existsSync(join(dir, '.git', 'REBASE_HEAD'))).toBe(true)
    await expectNothing(dir)
  }, GIT_TIMEOUT)

  test('a cherry-pick stopped on a conflict (CHERRY_PICK_HEAD)', async () => {
    const dir = repoWithConflictingBranches()
    gitStoppingOnConflict(dir, 'cherry-pick', 'side')
    expect(existsSync(join(dir, '.git', 'CHERRY_PICK_HEAD'))).toBe(true)
    await expectNothing(dir)
  }, GIT_TIMEOUT)

  test('a revert stopped on a conflict (REVERT_HEAD)', async () => {
    const dir = repoWithConflictingBranches()
    put(dir, 'shared.txt', 'main, edited again\n')
    snapshot(dir, 'again')
    gitStoppingOnConflict(dir, 'revert', '--no-edit', 'HEAD~1')
    expect(existsSync(join(dir, '.git', 'REVERT_HEAD'))).toBe(true)
    await expectNothing(dir)
  }, GIT_TIMEOUT)

  test('a linked worktree is checked in its own git directory', async () => {
    const dir = repoWithConflictingBranches()
    const linked = join(scratch, 'linked')
    git(dir, 'worktree', 'add', '-q', '-b', 'wt', linked, 'main')
    put(linked, 'other.txt', 'edit in the worktree\n')
    expect((await fetchGitDiff(linked))?.perFileStats.has('other.txt')).toBe(true)
    gitStoppingOnConflict(linked, 'merge', 'side')
    await expectNothing(linked)
    expect(await fetchGitDiff(dir)).not.toBeNull()
  }, GIT_TIMEOUT)
})

// ── without a root: the session's directory, in a fresh process ──────────

describe('without a root: the repository around the session directory', () => {
  test('the same numbers and hunks as with the root', async () => {
    const dir = repoWithEveryKindOfChange()
    expect(inFreshProcess(dir, 'fetchGitDiff')).toStrictEqual(plain(await fetchGitDiff(dir)))
    expect(inFreshProcess(dir, 'fetchGitDiffHunks')).toStrictEqual(plain(await fetchGitDiffHunks(dir)))
  }, GIT_TIMEOUT)

  test('outside any repository, or during a merge: null and an empty map', () => {
    const outside = join(scratch, 'not-a-repo')
    mkdirSync(outside)
    expect(inFreshProcess(outside, 'fetchGitDiff')).toBeNull()
    expect(inFreshProcess(outside, 'fetchGitDiffHunks')).toEqual([])
    const merging = repoWithConflictingBranches()
    gitStoppingOnConflict(merging, 'merge', 'side')
    expect(inFreshProcess(merging, 'fetchGitDiff')).toBeNull()
    expect(inFreshProcess(merging, 'fetchGitDiffHunks')).toEqual([])
  }, GIT_TIMEOUT)
})

// ── fetchDiffStatSummary ─────────────────────────────────────────────────

describe('fetchDiffStatSummary: the one-line diff readout', () => {
  /** main: a.txt; the caller checks out and commits on top. */
  function repoOnMain(): string {
    const dir = newRepo()
    put(dir, 'a.txt', 'one\ntwo\n')
    snapshot(dir, 'base')
    return dir
  }

  test('outside any repository: all null', () => {
    const outside = join(scratch, 'not-a-repo')
    mkdirSync(outside)
    expect(inFreshProcess(outside, 'fetchDiffStatSummary')).toStrictEqual(EMPTY_SUMMARY)
  }, GIT_TIMEOUT)

  test('on the base branch: the staged and unstaged tracked changes against HEAD; untracked files do not count', () => {
    const dir = repoOnMain()
    put(dir, 'a.txt', 'one\nTWO\nthree\n')
    put(dir, 'b.txt', 'staged\n')
    git(dir, 'add', 'b.txt')
    put(dir, 'untracked.txt', 'not counted\n')
    expect(inFreshProcess(dir, 'fetchDiffStatSummary')).toStrictEqual({
      uncommitted: { filesCount: 2, linesAdded: 3, linesRemoved: 1 },
      branch: null,
      branchBase: null,
    })
  }, GIT_TIMEOUT)

  test('on the base branch with nothing tracked changed, or before the first commit: all null', () => {
    const dir = repoOnMain()
    put(dir, 'untracked.txt', 'not counted\n')
    expect(inFreshProcess(dir, 'fetchDiffStatSummary')).toStrictEqual(EMPTY_SUMMARY)
    const unborn = newRepo('unborn')
    put(unborn, 'staged.txt', 'staged\n')
    git(unborn, 'add', 'staged.txt')
    expect(inFreshProcess(unborn, 'fetchDiffStatSummary')).toStrictEqual(EMPTY_SUMMARY)
  }, GIT_TIMEOUT)

  test('on a branch: everything since the merge-base with main, committed or not; later commits on main are not counted', () => {
    const dir = repoOnMain()
    git(dir, 'checkout', '-q', '-b', 'feature')
    put(dir, 'f.txt', 'feature one\nfeature two\n')
    snapshot(dir, 'feature work')
    git(dir, 'checkout', '-q', 'main')
    put(dir, 'm.txt', numbered(5, i => `main ${i}\n`))
    snapshot(dir, 'main moves on')
    git(dir, 'checkout', '-q', 'feature')
    put(dir, 'a.txt', 'one\ntwo\nthree\n')
    const expected = { uncommitted: null, branch: { filesCount: 2, linesAdded: 3, linesRemoved: 0 }, branchBase: 'main' }
    expect(inFreshProcess(dir, 'fetchDiffStatSummary')).toStrictEqual(expected)
    // An empty CLAUDIN_BASE_REF counts as unset.
    expect(inFreshProcess(dir, 'fetchDiffStatSummary', { CLAUDIN_BASE_REF: '' })).toStrictEqual(expected)
  }, GIT_TIMEOUT)

  test('CLAUDIN_BASE_REF names the base: its merge-base and its label', () => {
    const dir = repoOnMain()
    git(dir, 'checkout', '-q', '-b', 'release')
    put(dir, 'r.txt', 'release one\nrelease two\n')
    snapshot(dir, 'release work')
    git(dir, 'checkout', '-q', '-b', 'feature')
    put(dir, 'f.txt', 'feature\n')
    snapshot(dir, 'feature work')
    expect(inFreshProcess(dir, 'fetchDiffStatSummary', { CLAUDIN_BASE_REF: 'release' })).toStrictEqual({
      uncommitted: null,
      branch: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
      branchBase: 'release',
    })
    expect(inFreshProcess(dir, 'fetchDiffStatSummary')).toStrictEqual({
      uncommitted: null,
      branch: { filesCount: 2, linesAdded: 3, linesRemoved: 0 },
      branchBase: 'main',
    })
  }, GIT_TIMEOUT)

  test('a base with no merge-base (no such branch): the uncommitted changes against HEAD', () => {
    const dir = repoOnMain()
    git(dir, 'checkout', '-q', '-b', 'feature')
    put(dir, 'f.txt', 'committed on the branch\n')
    snapshot(dir, 'feature work')
    put(dir, 'a.txt', 'one\n')
    expect(inFreshProcess(dir, 'fetchDiffStatSummary', { CLAUDIN_BASE_REF: 'no-such-branch' })).toStrictEqual({
      uncommitted: { filesCount: 1, linesAdded: 0, linesRemoved: 1 },
      branch: null,
      branchBase: null,
    })
  }, GIT_TIMEOUT)

  test('without CLAUDIN_BASE_REF the base is the default branch origin/HEAD points to', () => {
    const upstream = newRepo('upstream', 'trunk')
    put(upstream, 'u.txt', 'upstream\n')
    snapshot(upstream, 'base')
    const clone = join(scratch, 'clone')
    git(scratch, 'clone', '-q', upstream, clone)
    git(clone, 'checkout', '-q', '-b', 'feature')
    put(clone, 'f.txt', 'feature\n')
    snapshot(clone, 'feature work')
    expect(inFreshProcess(clone, 'fetchDiffStatSummary')).toStrictEqual({
      uncommitted: null,
      branch: { filesCount: 1, linesAdded: 1, linesRemoved: 0 },
      branchBase: 'trunk',
    })
  }, GIT_TIMEOUT)
})
