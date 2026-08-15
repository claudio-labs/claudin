import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, isAbsolute, join } from 'path'

import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { extractGlobBaseDirectory, glob } from 'src/shared/fs/glob.js'

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
): Promise<{ files: string[]; truncated: boolean }> {
  return glob(
    pattern,
    cwd,
    { limit, offset },
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

describe('glob — CLAUDE_CODE_GLOB_HIDDEN', () => {
  let dir: string
  const previous = process.env.CLAUDE_CODE_GLOB_HIDDEN

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-hidden-'))
    mkdirSync(join(dir, 'visible'))
    mkdirSync(join(dir, '.hidden'))
    writeFileSync(join(dir, 'visible', 'shown.txt'), 'x')
    writeFileSync(join(dir, '.hidden', 'tucked.txt'), 'x')
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_GLOB_HIDDEN
    else process.env.CLAUDE_CODE_GLOB_HIDDEN = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('walks hidden directories by default', async () => {
    delete process.env.CLAUDE_CODE_GLOB_HIDDEN
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f)).sort()).toEqual([
      'shown.txt',
      'tucked.txt',
    ])
  })

  test('skips hidden directories when set to false', async () => {
    process.env.CLAUDE_CODE_GLOB_HIDDEN = 'false'
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f))).toEqual(['shown.txt'])
  })
})

describe('glob — CLAUDE_CODE_GLOB_NO_IGNORE', () => {
  let dir: string
  const previous = process.env.CLAUDE_CODE_GLOB_NO_IGNORE

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-ignore-'))
    mkdirSync(join(dir, 'kept'))
    mkdirSync(join(dir, 'skipped'))
    writeFileSync(join(dir, 'kept', 'kept.txt'), 'x')
    writeFileSync(join(dir, 'skipped', 'skipped.txt'), 'x')
    writeFileSync(join(dir, '.ignore'), 'skipped/\n')
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_GLOB_NO_IGNORE
    else process.env.CLAUDE_CODE_GLOB_NO_IGNORE = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('ignores ignore-files by default', async () => {
    delete process.env.CLAUDE_CODE_GLOB_NO_IGNORE
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f)).sort()).toEqual([
      'kept.txt',
      'skipped.txt',
    ])
  })

  test('honors ignore-files when set to false', async () => {
    process.env.CLAUDE_CODE_GLOB_NO_IGNORE = 'false'
    const { files } = await run('**/*.txt', dir)
    expect(files.map(f => basename(f))).toEqual(['kept.txt'])
  })
})
