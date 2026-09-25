import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
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

// The Read's globs ask for this (FileReadTool/readGlobs.ts); the Glob tool
// keeps the env default above.
describe('glob — respectGitignore', () => {
  let dir: string
  const previous = process.env.CLAUDIN_GLOB_NO_IGNORE

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-gitignore-'))
    // ripgrep reads a .gitignore only inside a repository.
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'kept'))
    mkdirSync(join(dir, 'skipped'))
    writeFileSync(join(dir, 'kept', 'kept.txt'), 'x')
    writeFileSync(join(dir, 'skipped', 'skipped.txt'), 'x')
    writeFileSync(join(dir, '.gitignore'), 'skipped/\n')
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.CLAUDIN_GLOB_NO_IGNORE
    else process.env.CLAUDIN_GLOB_NO_IGNORE = previous
    rmSync(dir, { recursive: true, force: true })
  })

  test('the default still lists what .gitignore leaves out', async () => {
    delete process.env.CLAUDIN_GLOB_NO_IGNORE
    const { files } = await runWith('**/*.txt', dir, { sort: 'path' })
    expect(files.map(f => basename(f))).toEqual(['kept.txt', 'skipped.txt'])
  })

  test('respectGitignore leaves it out, whatever CLAUDIN_GLOB_NO_IGNORE says', async () => {
    process.env.CLAUDIN_GLOB_NO_IGNORE = 'true'
    const { files } = await runWith('**/*.txt', dir, { sort: 'path', respectGitignore: true })
    expect(files.map(f => basename(f))).toEqual(['kept.txt'])
  })
})

// A positive --glob overrides ripgrep's ignore files for the FILES it matches;
// only ignored directories stayed skipped, which is all the suite above ever
// checked. The mock-model E2E found `src/*.ts` reading a .gitignore'd
// src/gen.ts (scripts/bench/ab/read-credit-e2e.ts, scenario 6).
describe('glob — respectGitignore on a file the pattern names', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'glob-gitignore-file-'))
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    for (const file of ['one.ts', 'gen.ts', 'deep/two.ts', 'notes.md']) {
      writeFileSync(join(dir, 'src', file), 'x')
    }
    writeFileSync(join(dir, '.env.ts'), 'x')
    writeFileSync(join(dir, '.gitignore'), 'src/gen.ts\n.env.ts\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const names = (files: string[]) => files.map(f => f.slice(dir.length + 1))
  const opts = { sort: 'path', type: 'file', respectGitignore: true } as const

  test('the Read\'s own call — `./*.ts` from the glob\'s base — leaves the file out', async () => {
    const { files } = await runWith('./*.ts', join(dir, 'src'), opts)
    expect(names(files)).toEqual(['src/one.ts'])
  })

  test('an anchored pattern stays in its own directory', async () => {
    expect(names((await runWith('./*.ts', dir, opts)).files)).toEqual([])
    expect(names((await runWith('src/*.ts', dir, opts)).files)).toEqual(['src/one.ts'])
  })

  test('`**` and a bare name reach every depth, still without the ignored files', async () => {
    expect(names((await runWith('**/*.ts', dir, opts)).files)).toEqual([
      'src/deep/two.ts',
      'src/one.ts',
    ])
    expect(names((await runWith('*.ts', dir, opts)).files)).toEqual([
      'src/deep/two.ts',
      'src/one.ts',
    ])
  })

  // The in-process match must read every pattern as --glob does, so parity
  // with the default listing is the test: the same files, less the ignored.
  test('a pattern reads as --glob reads it: the default listing, less the ignored files', async () => {
    const previous = process.env.CLAUDIN_GLOB_NO_IGNORE
    delete process.env.CLAUDIN_GLOB_NO_IGNORE
    try {
      const cases: [string, string, boolean][] = [
        // Absolute, and no `/` after its base: the name at any depth, as always.
        [`${dir}/src/*.TS`, dir, true],
        ['src/**/*.ts', dir, false],
        ['*.ts', join(dir, 'src'), false],
        ['./deep/*.ts', join(dir, 'src'), false],
      ]
      for (const [pattern, root, caseInsensitive] of cases) {
        const plain = names((await runWith(pattern, root, { sort: 'path', caseInsensitive })).files)
        const kept = names((await runWith(pattern, root, { ...opts, caseInsensitive })).files)
        expect([pattern, kept]).toEqual([
          pattern,
          plain.filter(p => p !== 'src/gen.ts' && p !== '.env.ts'),
        ])
        expect(kept.length).toBeGreaterThan(0)
      }
    } finally {
      if (previous !== undefined) process.env.CLAUDIN_GLOB_NO_IGNORE = previous
    }
  })

  // The walk lists dotfiles (--hidden) and ripgrep's `*` matches them, so the
  // in-process match must too — an ignored one aside.
  test('a dotfile the pattern matches is listed unless it is ignored', async () => {
    const dots = mkdtempSync(join(tmpdir(), 'glob-gitignore-dots-'))
    try {
      mkdirSync(join(dots, '.git'))
      writeFileSync(join(dots, '.hidden.ts'), 'x')
      writeFileSync(join(dots, '.ignored.ts'), 'x')
      writeFileSync(join(dots, '.gitignore'), '.ignored.ts\n')
      const { files } = await runWith('./*.ts', dots, opts)
      expect(files.map(f => basename(f))).toEqual(['.hidden.ts'])
    } finally {
      rmSync(dots, { recursive: true, force: true })
    }
  })

  // Matching here is for files: a directory is found by the files under it,
  // one level deeper than its pattern reaches, so it keeps ripgrep's walk.
  test('a directory listing keeps the glob walk under respectGitignore', async () => {
    const { files } = await runWith('./deep', join(dir, 'src'), { ...opts, type: 'dir' })
    expect(names(files)).toEqual(['src/deep'])
  })

  test('without respectGitignore the default listing is unchanged', async () => {
    const previous = process.env.CLAUDIN_GLOB_NO_IGNORE
    delete process.env.CLAUDIN_GLOB_NO_IGNORE
    try {
      const { files } = await runWith('./*.ts', join(dir, 'src'), { sort: 'path' })
      expect(names(files)).toEqual(['src/gen.ts', 'src/one.ts'])
    } finally {
      if (previous !== undefined) process.env.CLAUDIN_GLOB_NO_IGNORE = previous
    }
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

  // A pattern with a `/` is anchored at the search root. ripgrep anchors it at
  // its own working directory, so these all matched nothing while ripgrep ran
  // from this process's cwd — this fixture lives outside it on purpose.
  describe('a pattern with a slash, anchored at the search root', () => {
    const rel = (files: string[]) => files.map(f => f.slice(dir.length + 1))

    test('one level of directory', async () => {
      const { files } = await runWith('*/*.txt', dir, { sort: 'path' })
      expect(rel(files)).toEqual(['a/keep.txt', 'b/other.txt'])
    })

    test('a wildcard in the middle', async () => {
      const { files } = await runWith('a/*/nested.txt', dir, {})
      expect(rel(files)).toEqual(['a/deep/nested.txt'])
    })

    test('a leading ./ is the search root itself', async () => {
      const { files } = await runWith('./*.txt', dir, {})
      expect(rel(files)).toEqual(['z.txt'])
    })

    test('an anchored exclude drops its subtree', async () => {
      const { files } = await runWith('**/*.txt', dir, { exclude: ['a/**'], sort: 'path' })
      expect(rel(files)).toEqual(['b/other.txt', 'z.txt'])
    })

    test('type:dir with an anchored pattern', async () => {
      const { files } = await runWith('a/*', dir, { type: 'dir' })
      expect(rel(files)).toEqual(['a/deep'])
    })

    test('type:dir with a leading ./ lists only the top-level match', async () => {
      const { files } = await runWith('./a', dir, { type: 'dir' })
      expect(rel(files)).toEqual(['a'])
    })

    test('type:dir with a leading ./ skips a same-named directory nested inside it', async () => {
      // Only observable when the match holds a directory of the same name: the
      // walk is already confined to the top-level `a`, so it is the derivation
      // that must not re-match `a/a` by its segment name.
      const nest = mkdtempSync(join(tmpdir(), 'glob-nest-'))
      try {
        mkdirSync(join(nest, 'a', 'a'), { recursive: true })
        writeFileSync(join(nest, 'a', 'a', 'x.txt'), 'x')
        const anchored = await runWith('./a', nest, { type: 'dir', sort: 'path' })
        expect(anchored.files.map(f => f.slice(nest.length + 1))).toEqual(['a'])
        const anywhere = await runWith('a', nest, { type: 'dir', sort: 'path' })
        expect(anywhere.files.map(f => f.slice(nest.length + 1))).toEqual(['a', 'a/a'])
      } finally {
        rmSync(nest, { recursive: true, force: true })
      }
    })

    test('under a symlinked root, paths keep the name it was reached by', async () => {
      const link = `${dir}-link`
      symlinkSync(dir, link)
      try {
        const { files } = await runWith('*/*.txt', link, { sort: 'path' })
        expect(files.map(f => f.slice(link.length + 1))).toEqual(['a/keep.txt', 'b/other.txt'])
      } finally {
        rmSync(link, { force: true })
      }
    })

    test('an absolute pattern under a directory that does not exist matches nothing', async () => {
      const { files, truncated } = await runWith(join(dir, 'missing', '*', '*.txt'), dir, {})
      expect(files).toEqual([])
      expect(truncated).toBe(false)
    })

    test('a Read deny rule under the search root hides its files', async () => {
      // The deny patterns are normalized to the search root with a leading `/`,
      // which ripgrep anchors at its working directory — so they only applied
      // when that happened to be the search root.
      const denying = {
        ...permissionContext,
        alwaysDenyRules: { cliArg: [`Read(/${dir}/b/**)`] },
      } as unknown as ToolPermissionContext
      const { files } = await glob(
        '**/*.txt',
        dir,
        { limit: 100, offset: 0, sort: 'path' },
        new AbortController().signal,
        denying,
      )
      expect(rel(files)).toEqual(['a/deep/nested.txt', 'a/keep.txt', 'z.txt'])
    })
  })
})
