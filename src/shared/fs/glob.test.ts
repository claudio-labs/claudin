import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, isAbsolute, join } from 'path'

import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  deriveDirectories,
  extractGlobBaseDirectory,
  glob,
  type GlobOptions,
} from 'src/shared/fs/glob.js'

const permissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: true,
} as unknown as ToolPermissionContext

function run(
  pattern: string,
  cwd: string,
  limit = 100,
  offset = 0,
  caseInsensitive?: boolean,
): Promise<{ files: string[]; truncated: boolean }> {
  return glob(
    pattern,
    cwd,
    { limit, offset, caseInsensitive },
    new AbortController().signal,
    permissionContext,
  )
}

/** The same call with the options the find-shaped parameters use. */
function runWith(
  pattern: string,
  cwd: string,
  options: Partial<GlobOptions>,
): Promise<{ files: string[]; truncated: boolean }> {
  return glob(
    pattern,
    cwd,
    { limit: 100, offset: 0, ...options },
    new AbortController().signal,
    permissionContext,
  )
}

describe('extractGlobBaseDirectory', () => {
  test('leaves a cwd-relative pattern alone', () => {
    expect(extractGlobBaseDirectory('**/*.ts')).toEqual({
      baseDir: '',
      relativePattern: '**/*.ts',
    })
  })

  test('splits the static prefix off a relative pattern', () => {
    expect(extractGlobBaseDirectory('src/**/*.ts')).toEqual({
      baseDir: 'src',
      relativePattern: '**/*.ts',
    })
  })

  test('splits an absolute pattern into base dir + relative pattern', () => {
    expect(extractGlobBaseDirectory('/tmp/foo/**/*.ts')).toEqual({
      baseDir: '/tmp/foo',
      relativePattern: '**/*.ts',
    })
  })

  test('treats a literal path as dirname + filename', () => {
    expect(extractGlobBaseDirectory('/tmp/foo/bar.ts')).toEqual({
      baseDir: '/tmp/foo',
      relativePattern: 'bar.ts',
    })
  })

  test('keeps the root directory as the base for a root-level pattern', () => {
    expect(extractGlobBaseDirectory('/*.txt')).toEqual({
      baseDir: '/',
      relativePattern: '*.txt',
    })
  })
})

describe('glob — ordering, cap and pagination', () => {
  let dir: string

  // a.txt is the OLDEST and e.txt the NEWEST, so a filename sort produces the
  // exact inverse of the expected order — a regression back to --sort=modified
  // (ascending) fails every assertion below instead of passing by accident.
  const NEWEST_FIRST = ['e.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt']

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-order-'))
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
    names.forEach((name, i) => {
      const file = join(dir, name)
      writeFileSync(file, 'x')
      // Whole seconds apart so the order cannot depend on filesystem mtime
      // granularity.
      const seconds = 1_000_000 + i * 10
      utimesSync(file, seconds, seconds)
    })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns the most recently modified files first', async () => {
    const { files, truncated } = await run('*.txt', dir)
    expect(files.map(f => basename(f))).toEqual(NEWEST_FIRST)
    expect(truncated).toBe(false)
  })

  test('returns absolute paths', async () => {
    const { files } = await run('*.txt', dir)
    expect(files.every(f => isAbsolute(f))).toBe(true)
  })

  test('a truncated result keeps the newest files, not the oldest', async () => {
    const { files, truncated } = await run('*.txt', dir, 2)
    expect(files.map(f => basename(f))).toEqual(['e.txt', 'd.txt'])
    expect(truncated).toBe(true)
  })

  test('offset pages past the files already returned', async () => {
    const { files, truncated } = await run('*.txt', dir, 2, 2)
    expect(files.map(f => basename(f))).toEqual(['c.txt', 'b.txt'])
    expect(truncated).toBe(true)
  })

  test('the last page is not reported as truncated', async () => {
    const { files, truncated } = await run('*.txt', dir, 10, 3)
    expect(files.map(f => basename(f))).toEqual(['b.txt', 'a.txt'])
    expect(truncated).toBe(false)
  })

  test('an absolute pattern searches its own base directory', async () => {
    const { files } = await run(join(dir, '*.txt'), '/definitely/not/here')
    expect(files.map(f => basename(f))).toEqual(NEWEST_FIRST)
  })

  test('a pattern that matches nothing returns an empty, untruncated result', async () => {
    const { files, truncated } = await run('*.nomatch', dir)
    expect(files).toEqual([])
    expect(truncated).toBe(false)
  })
})

describe('glob — CLAUDIN_GLOB_HIDDEN', () => {
  let dir: string
  const previous = process.env.CLAUDIN_GLOB_HIDDEN

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-hidden-'))
    mkdirSync(join(dir, 'visible'))
    mkdirSync(join(dir, '.hidden'))
    writeFileSync(join(dir, 'visible', 'shown.txt'), 'x')
    writeFileSync(join(dir, '.hidden', 'tucked.txt'), 'x')
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDIN_GLOB_HIDDEN
    else process.env.CLAUDIN_GLOB_HIDDEN = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('walks hidden directories by default', async () => {
    delete process.env.CLAUDIN_GLOB_HIDDEN
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f)).sort()).toEqual([
      'shown.txt',
      'tucked.txt',
    ])
  })

  test('skips hidden directories when set to false', async () => {
    process.env.CLAUDIN_GLOB_HIDDEN = 'false'
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f))).toEqual(['shown.txt'])
  })
})

describe('glob — CLAUDIN_GLOB_NO_IGNORE', () => {
  let dir: string
  const previous = process.env.CLAUDIN_GLOB_NO_IGNORE

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-ignore-'))
    mkdirSync(join(dir, 'kept'))
    mkdirSync(join(dir, 'skipped'))
    writeFileSync(join(dir, 'kept', 'kept.txt'), 'x')
    writeFileSync(join(dir, 'skipped', 'skipped.txt'), 'x')
    writeFileSync(join(dir, '.ignore'), 'skipped/\n')
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDIN_GLOB_NO_IGNORE
    else process.env.CLAUDIN_GLOB_NO_IGNORE = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('ignores ignore-files by default', async () => {
    delete process.env.CLAUDIN_GLOB_NO_IGNORE
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f)).sort()).toEqual([
      'kept.txt',
      'skipped.txt',
    ])
  })

  test('honors ignore-files when set to false', async () => {
    process.env.CLAUDIN_GLOB_NO_IGNORE = 'false'
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f))).toEqual(['kept.txt'])
  })
})

describe('glob — case-insensitive matching', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-case-'))
    writeFileSync(join(dir, 'README.md'), 'x')
    writeFileSync(join(dir, 'notes.md'), 'x')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('is case-sensitive by default', async () => {
    // The guard against reaching for --iglob unconditionally: Glob has always
    // been sensitive, and widening the default would change what every
    // existing call answers.
    const { files } = await run('*readme*', dir)
    expect(files).toEqual([])
  })

  test('matches either case when asked', async () => {
    const { files } = await run('*readme*', dir, 100, 0, true)
    expect(files.map(f => basename(f))).toEqual(['README.md'])
  })

  test('a pattern already in the right case is unaffected by the flag', async () => {
    const sensitive = await run('*notes*', dir)
    const insensitive = await run('*notes*', dir, 100, 0, true)
    expect(sensitive.files.map(f => basename(f))).toEqual(['notes.md'])
    expect(insensitive.files.map(f => basename(f))).toEqual(['notes.md'])
  })
})

describe('deriveDirectories', () => {
  const paths = ['a/keep.txt', 'a/deep/nested.txt', 'b/other.txt']

  test('a pattern with no slash matches the segment name at any depth', () => {
    expect(deriveDirectories(paths, 'deep', {})).toEqual(['a/deep'])
  })

  test('a pattern with a slash is anchored at the search root', () => {
    // `deep` alone would match a/deep; `a/deep` must not match a bare `deep`
    // somewhere else, which is the whole difference the anchoring makes.
    expect(deriveDirectories(paths, 'a/deep', {})).toEqual(['a/deep'])
    expect(deriveDirectories(['x/deep/f.txt'], 'a/deep', {})).toEqual([])
  })

  test('lists every ancestor once, in the order the walk produced them', () => {
    expect(deriveDirectories(paths, '*', {})).toEqual(['a', 'a/deep', 'b'])
  })

  test('a ./ prefix is not an ancestor', () => {
    // ripgrep writes `./a/f.txt` when it is given `.`, and `.` would otherwise
    // come out as a directory matching every pattern.
    expect(deriveDirectories(['./a/f.txt'], '*', {})).toEqual(['a'])
  })

  test('maxDepth cuts the ancestors, not the files', () => {
    expect(deriveDirectories(paths, '*', { maxDepth: 1 })).toEqual(['a', 'b'])
  })

  test('matches either case only when asked', () => {
    const files = ['Docs/readme.md']
    expect(deriveDirectories(files, 'docs', {})).toEqual([])
    expect(deriveDirectories(files, 'docs', { caseInsensitive: true })).toEqual([
      'Docs',
    ])
  })
})

describe('glob — the find-shaped parameters', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-find-'))
    mkdirSync(join(dir, 'a', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'b'), { recursive: true })
    mkdirSync(join(dir, 'empty'), { recursive: true })
    // `a-b` sorts BEFORE `a/deep` (0x2D < 0x2F) while its file sorts before
    // every file under `a`, so first-appearance order and path order disagree
    // here — which is the only place the directory re-sort is observable.
    mkdirSync(join(dir, 'a-b'), { recursive: true })
    writeFileSync(join(dir, 'a-b', 'x.log'), 'x')
    writeFileSync(join(dir, 'z.txt'), 'x')
    writeFileSync(join(dir, 'a', 'keep.txt'), 'x')
    writeFileSync(join(dir, 'a', 'deep', 'nested.txt'), 'x')
    writeFileSync(join(dir, 'b', 'other.txt'), 'x')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('maxDepth stops the walk the way find -maxdepth does', async () => {
    const { files } = await runWith('**/*.txt', dir, { maxDepth: 1 })
    expect(files.map(f => basename(f))).toEqual(['z.txt'])
  })

  test('maxDepth 2 reaches one level of subdirectory', async () => {
    const { files } = await runWith('**/*.txt', dir, { maxDepth: 2 })
    expect(files.map(f => basename(f)).sort()).toEqual([
      'keep.txt',
      'other.txt',
      'z.txt',
    ])
  })

  test('sort:path returns alphabetical order, not mtime order', async () => {
    const { files } = await runWith('**/*.txt', dir, { sort: 'path' })
    expect(files.map(f => f.slice(dir.length + 1))).toEqual([
      'a/deep/nested.txt',
      'a/keep.txt',
      'b/other.txt',
      'z.txt',
    ])
  })

  test('exclude drops a subtree', async () => {
    const { files } = await runWith('**/*.txt', dir, {
      exclude: ['**/a/**'],
      sort: 'path',
    })
    expect(files.map(f => basename(f))).toEqual(['other.txt', 'z.txt'])
  })

  test('type:dir lists directories and skips the empty one', async () => {
    const { files } = await runWith('*', dir, { type: 'dir', sort: 'path' })
    expect(files.map(f => f.slice(dir.length + 1))).toEqual([
      'a',
      'a-b',
      'a/deep',
      'b',
    ])
  })

  test('type:dir honors maxDepth against the DIRECTORY depth', async () => {
    // a/deep is at depth 2 and its file at depth 3, so a naive pass-through of
    // maxDepth to ripgrep would return nothing at all here.
    const { files } = await runWith('*', dir, {
      type: 'dir',
      maxDepth: 1,
      sort: 'path',
    })
    expect(files.map(f => f.slice(dir.length + 1))).toEqual(['a', 'a-b', 'b'])
  })

  test('type:dir with the default ordering follows the walk, not the alphabet', async () => {
    // The mtime ranking reaches directories as "the one holding the most
    // recently modified file first", so the listing is NOT sorted — and the
    // path ordering above is a real re-sort rather than a coincidence of how
    // ancestors come out of a path-sorted walk.
    const { files } = await runWith('*', dir, { type: 'dir' })
    const listed = files.map(f => f.slice(dir.length + 1))
    expect(listed.sort()).not.toEqual(files.map(f => f.slice(dir.length + 1)))
  })

  test('type:dir filters by the pattern, like find -type d -name', async () => {
    const { files } = await runWith('deep', dir, { type: 'dir' })
    expect(files.map(f => f.slice(dir.length + 1))).toEqual(['a/deep'])
  })
})
