// Globs in a batch Read's file_paths (readGlobs.ts, CLAUDIN_READ_GLOBS). The
// expansion is driven with injected deps, so what it lists — and what it never
// lists — is observable without touching a disk; the last describe runs the
// real FileReadTool.resolveInput over a temp project, through the real glob().
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { AbortError, isAbortError } from 'src/shared/errors.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { getFsImplementation, setFsImplementation } from 'src/shared/fs/fsOperations.js'
import { extractGlobBaseDirectory } from 'src/shared/fs/glob.js'
import { getInMemoryErrors } from 'src/shared/log.js'
import {
  getEmptyToolPermissionContext,
  type ResolvedInput,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { importWithReadGlobs } from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'
import {
  expandReadGlobs,
  isReadGlob,
  MAX_GLOB_FILES,
  readGlobsEnabledAtLoad,
  resolveReadGlobs,
  type GlobMatches,
  type ReadGlobDeps,
} from 'src/tools/FileReadTool/readGlobs.js'
import type { Input } from 'src/tools/FileReadTool/schemas.js'

const PROJECT = '/proj'

type FakeDisk = {
  /** Files that exist as written. */
  files?: string[]
  /** What each absolute pattern lists: its files, or the whole answer. */
  matches?: Record<string, string[] | GlobMatches>
  /** Throws instead of listing. */
  listingFails?: Error
}

/** Deps over a fake disk under /proj, recording every call that would touch it. */
function fakeDeps(disk: FakeDisk = {}) {
  const listed: { pattern: string; limit: number }[] = []
  const statted: string[] = []
  const deps: ReadGlobDeps = {
    cwd: PROJECT,
    baseDirectoryOf: pattern => extractGlobBaseDirectory(pattern).baseDir,
    isInsideProject: dir => dir === PROJECT || dir.startsWith(`${PROJECT}/`),
    async isFile(path) {
      statted.push(path)
      return disk.files?.includes(path) ?? false
    },
    async listMatches(pattern, limit) {
      listed.push({ pattern, limit })
      if (disk.listingFails) throw disk.listingFails
      const answer = disk.matches?.[pattern] ?? []
      return Array.isArray(answer) ? { files: answer, incomplete: null } : answer
    },
  }
  return { deps, listed, statted }
}

function filesUnder(dir: string, count: number, ext = 'ts'): string[] {
  return Array.from({ length: count }, (_, i) => `${dir}/f${String(i).padStart(3, '0')}.${ext}`)
}

describe('isReadGlob', () => {
  test('a live *, ?, [ or { makes an entry a glob', () => {
    for (const entry of ['/proj/src/*.ts', 'src/a?.ts', 'src/[ab].ts', 'src/{a,b}.ts', '**/x']) {
      expect(isReadGlob(entry)).toBe(true)
    }
  })

  test('a plain path is not one', () => {
    for (const entry of ['/proj/src/a.ts', 'src/a-b_c.d.ts', '~/notes.md', './x.ts']) {
      expect(isReadGlob(entry)).toBe(false)
    }
  })

  test('a backslash escapes the character after it, and an escaped backslash does not', () => {
    expect(isReadGlob('src/a\\*.ts')).toBe(false)
    expect(isReadGlob('app/\\[slug\\]/page.tsx')).toBe(false)
    expect(isReadGlob('src/a\\\\*.ts')).toBe(true)
  })
})

describe('readGlobsEnabledAtLoad', () => {
  test('off unless CLAUDIN_READ_GLOBS is truthy', () => {
    const prior = process.env.CLAUDIN_READ_GLOBS
    try {
      delete process.env.CLAUDIN_READ_GLOBS
      expect(readGlobsEnabledAtLoad()).toBe(false)
      process.env.CLAUDIN_READ_GLOBS = '0'
      expect(readGlobsEnabledAtLoad()).toBe(false)
      process.env.CLAUDIN_READ_GLOBS = '1'
      expect(readGlobsEnabledAtLoad()).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.CLAUDIN_READ_GLOBS
      else process.env.CLAUDIN_READ_GLOBS = prior
    }
  })
})

describe('expandReadGlobs — where a glob points', () => {
  test('a relative glob resolves against the working directory; an absolute one stays as given', async () => {
    const { deps, listed } = fakeDeps({
      matches: {
        '/proj/src/*.ts': ['/proj/src/a.ts'],
        '/proj/lib/*.ts': ['/proj/lib/b.ts'],
      },
    })
    const result = await expandReadGlobs(['src/*.ts', '/proj/lib/*.ts'], deps)
    expect(result).toEqual({ ok: true, paths: ['/proj/src/a.ts', '/proj/lib/b.ts'] })
    // A limit just past the cap, so a glob over it can be told apart.
    expect(listed).toEqual([
      { pattern: '/proj/src/*.ts', limit: MAX_GLOB_FILES + 1 },
      { pattern: '/proj/lib/*.ts', limit: MAX_GLOB_FILES + 1 },
    ])
  })

  test('a glob outside the project refuses the call before anything is listed or read', async () => {
    const { deps, listed, statted } = fakeDeps({
      matches: { '/proj/src/*.ts': ['/proj/src/a.ts'] },
    })
    // The glob inside comes first: it is not listed either.
    const result = await expandReadGlobs(['src/*.ts', '/etc/*.conf', '../elsewhere/**/*.md'], deps)
    expect(result).toEqual({
      ok: false,
      message: [
        '/etc/*.conf: globs in file_paths expand only inside the project — list /etc with Glob first.',
        '../elsewhere/**/*.md: globs in file_paths expand only inside the project — list /elsewhere with Glob first.',
      ].join('\n'),
    })
    expect(listed).toEqual([])
    expect(statted).toEqual([])
  })

  test('a glob that names an existing file as written is that file, and is not listed', async () => {
    const { deps, listed } = fakeDeps({ files: ['/proj/app/[slug]/page.tsx'] })
    const result = await expandReadGlobs(['app/[slug]/page.tsx', '/proj/app/layout.tsx'], deps)
    expect(result).toEqual({
      ok: true,
      paths: ['app/[slug]/page.tsx', '/proj/app/layout.tsx'],
    })
    expect(listed).toEqual([])
  })
})

describe('expandReadGlobs — order and repeats', () => {
  test('entries keep their order, a glob its matches in path order, and each file comes once', async () => {
    const { deps } = fakeDeps({
      matches: {
        '/proj/src/*.ts': ['/proj/src/a.ts', '/proj/src/b.ts', '/proj/src/c.ts'],
        '/proj/test/*.ts': ['/proj/test/t.ts'],
      },
    })
    const result = await expandReadGlobs(
      ['src/b.ts', '/proj/src/*.ts', 'test/*.ts', '/proj/src/a.ts'],
      deps,
    )
    // src/b.ts is named first, as written; the glob does not bring it back,
    // and the literal a.ts after the glob adds nothing.
    expect(result).toEqual({
      ok: true,
      paths: ['src/b.ts', '/proj/src/a.ts', '/proj/src/c.ts', '/proj/test/t.ts'],
    })
  })

  test('a glob named twice is listed once', async () => {
    const { deps, listed } = fakeDeps({ matches: { '/proj/src/*.ts': ['/proj/src/a.ts'] } })
    const result = await expandReadGlobs(['src/*.ts', 'src/*.ts'], deps)
    expect(result).toEqual({ ok: true, paths: ['/proj/src/a.ts'] })
    expect(listed).toHaveLength(1)
  })

  test('a glob named twice outside the project is refused once', async () => {
    const { deps } = fakeDeps()
    expect(await expandReadGlobs(['/etc/*.conf', '/etc/*.conf'], deps)).toEqual({
      ok: false,
      message: '/etc/*.conf: globs in file_paths expand only inside the project — list /etc with Glob first.',
    })
  })
})

describe('expandReadGlobs — nothing matched', () => {
  test('a glob that matches nothing is dropped', async () => {
    const { deps } = fakeDeps({ matches: { '/proj/src/*.ts': ['/proj/src/a.ts'] } })
    expect(await expandReadGlobs(['src/*.ts', 'test/*.ts', '/proj/README.md'], deps)).toEqual({
      ok: true,
      paths: ['/proj/src/a.ts', '/proj/README.md'],
    })
  })

  test('nothing left refuses the call, naming the globs', async () => {
    const { deps } = fakeDeps()
    expect(await expandReadGlobs(['src/*.tsx', 'test/*.tsx'], deps)).toEqual({
      ok: false,
      message: 'No file matches src/*.tsx, test/*.tsx.',
    })
  })
})

describe('expandReadGlobs — the cap', () => {
  test(`${MAX_GLOB_FILES} files are one call`, async () => {
    const files = filesUnder('/proj/src', MAX_GLOB_FILES)
    const { deps } = fakeDeps({ matches: { '/proj/src/*.ts': files } })
    expect(await expandReadGlobs(['src/*.ts'], deps)).toEqual({ ok: true, paths: files })
  })

  test('a glob over the cap refuses the call, naming it', async () => {
    const { deps } = fakeDeps({
      matches: { '/proj/src/**/*.ts': filesUnder('/proj/src', MAX_GLOB_FILES + 1) },
    })
    expect(await expandReadGlobs(['src/**/*.ts'], deps)).toEqual({
      ok: false,
      message: `src/**/*.ts matches more than ${MAX_GLOB_FILES} files; Read takes ${MAX_GLOB_FILES} per call — narrow the pattern or split it.`,
    })
  })

  test('the entry that takes the call past the cap is the one named', async () => {
    const { deps } = fakeDeps({
      matches: {
        '/proj/a/*.ts': filesUnder('/proj/a', 30),
        '/proj/b/*.ts': filesUnder('/proj/b', 21),
      },
    })
    expect(await expandReadGlobs(['a/*.ts', 'b/*.ts'], deps)).toEqual({
      ok: false,
      message: `With b/*.ts the call matches more than ${MAX_GLOB_FILES} files; Read takes ${MAX_GLOB_FILES} per call — narrow the patterns or split the call.`,
    })
  })

  test('a plain path counts toward it too', async () => {
    const { deps } = fakeDeps({ matches: { '/proj/a/*.ts': filesUnder('/proj/a', MAX_GLOB_FILES) } })
    const result = await expandReadGlobs(['a/*.ts', '/proj/README.md'], deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.startsWith('With /proj/README.md the call')).toBe(true)
  })

  test('files two globs share are counted once', async () => {
    const shared = filesUnder('/proj/a', 20)
    const { deps } = fakeDeps({
      matches: {
        '/proj/a/*.ts': [...shared, ...filesUnder('/proj/a/x', 10)],
        '/proj/a/f0*.ts': [...shared, ...filesUnder('/proj/a/y', 10)],
      },
    })
    const result = await expandReadGlobs(['a/*.ts', 'a/f0*.ts'], deps)
    expect(result.ok && result.paths.length).toBe(40)
  })
})

describe('expandReadGlobs — a listing that does not finish', () => {
  test('a walk ripgrep cut short refuses the call rather than reading part of it', async () => {
    const { deps } = fakeDeps({
      matches: { '/proj/src/*.ts': { files: ['/proj/src/a.ts'], incomplete: 'timeout' } },
    })
    expect(await expandReadGlobs(['src/*.ts'], deps)).toEqual({
      ok: false,
      message: 'src/*.ts: the listing stopped before it finished — narrow the pattern.',
    })
  })

  test('a cancelled walk is the cancellation, not a refusal', async () => {
    const { deps } = fakeDeps({
      matches: { '/proj/src/*.ts': { files: [], incomplete: 'aborted' } },
    })
    const error = await expandReadGlobs(['src/*.ts'], deps).catch((e: unknown) => e)
    expect(isAbortError(error)).toBe(true)
  })

  test('a cancellation thrown by the listing goes through as it came', async () => {
    const { deps } = fakeDeps({ listingFails: new AbortError() })
    const error = await expandReadGlobs(['src/*.ts'], deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AbortError)
  })

  test('a listing that fails refuses the call, naming the glob', async () => {
    const { deps } = fakeDeps({ listingFails: new Error('ripgrep is not installed') })
    expect(await expandReadGlobs(['src/*.ts'], deps)).toEqual({
      ok: false,
      message: 'src/*.ts: ripgrep is not installed — list the files with Glob instead.',
    })
  })
})

describe('expandReadGlobs — a path expandPath refuses (a null byte)', () => {
  test('a glob refuses the call, naming it, before anything is listed', async () => {
    const { deps, listed } = fakeDeps({ matches: { '/proj/src/*.ts': ['/proj/src/a.ts'] } })
    expect(await expandReadGlobs(['src/*.ts', 'lib/\0*.ts'], deps)).toEqual({
      ok: false,
      message: 'lib/\0*.ts: Path contains null bytes',
    })
    expect(listed).toEqual([])
  })

  test('a plain path stays as written, for validateInput to refuse by name', async () => {
    const { deps } = fakeDeps({ matches: { '/proj/src/*.ts': ['/proj/src/a.ts'] } })
    expect(await expandReadGlobs(['src/*.ts', 'lib/a\0.ts'], deps)).toEqual({
      ok: true,
      paths: ['/proj/src/a.ts', 'lib/a\0.ts'],
    })
  })
})

describe('resolveReadGlobs', () => {
  test('an input with no glob is handed back as it came, and nothing is listed', async () => {
    const { deps, listed, statted } = fakeDeps()
    for (const input of [
      { file_path: '/proj/a.ts' },
      { file_paths: ['/proj/a.ts', '/proj/b.ts'] },
    ] satisfies Input[]) {
      const result = await resolveReadGlobs(input, deps)
      expect(result.ok && result.input).toBe(input)
    }
    expect(listed).toEqual([])
    expect(statted).toEqual([])
  })

  test('a shape validateInput refuses is left for it to refuse, unlisted', async () => {
    const { deps, listed } = fakeDeps()
    for (const input of [
      { file_path: '/proj/a.ts', file_paths: ['src/*.ts'] },
      { file_paths: ['src/*.ts'], offset: 3 },
    ] satisfies Input[]) {
      const result = await resolveReadGlobs(input, deps)
      expect(result.ok && result.input).toBe(input)
    }
    expect(listed).toEqual([])
  })

  test('the expanded input keeps every other field; view and symbol apply to each file', async () => {
    const { deps } = fakeDeps({
      matches: { '/proj/src/*.ts': ['/proj/src/a.ts', '/proj/src/b.ts'] },
    })
    expect(
      await resolveReadGlobs({ file_paths: ['src/*.ts'], view: 'outline', symbol: ['x', 'y'] }, deps),
    ).toEqual({
      ok: true,
      input: { file_paths: ['/proj/src/a.ts', '/proj/src/b.ts'], view: 'outline', symbol: ['x', 'y'] },
    })
  })

  test('a refused expansion is a refused resolution', async () => {
    const { deps } = fakeDeps()
    expect(await resolveReadGlobs({ file_paths: ['src/*.tsx'] }, deps)).toEqual({
      ok: false,
      message: 'No file matches src/*.tsx.',
    })
  })
})

// The real thing: FileReadTool.resolveInput with its own deps, over a temp
// project, through glob.ts and ripgrep. Each arm loads its own instance of
// FileReadTool.ts, because the flag is read once, at load.
describe('FileReadTool.resolveInput — CLAUDIN_READ_GLOBS over a real project', () => {
  type ReadModule = typeof import('src/tools/FileReadTool/FileReadTool.js')
  type Schemas = typeof import('src/tools/FileReadTool/schemas.js')
  type ReadTool = ReadModule['FileReadTool']

  let project = ''
  let elsewhere = ''
  let ReadOn: ReadTool
  let ReadOff: ReadTool
  let schemasOn: Schemas
  let schemasOff: Schemas

  function write(relative: string, content = 'x\n'): string {
    const path = join(project, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'read-globs-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'read-globs-elsewhere-'))
    // ripgrep honors a .gitignore inside a repository, which a .git makes this.
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, '.gitignore'), 'ignored/\nnode_modules/\n')
    for (const file of [
      'src/a.ts',
      'src/b.ts',
      'src/nested/c.ts',
      'ignored/x.ts',
      'node_modules/pkg/index.ts',
      'README.md',
    ]) {
      write(file)
    }
    for (let i = 0; i < MAX_GLOB_FILES + 1; i++) write(`many/f${String(i).padStart(2, '0')}.txt`)
    writeFileSync(join(elsewhere, 'e.ts'), 'x\n')
    ReadOn = (await importWithReadGlobs<ReadModule>('src/tools/FileReadTool/FileReadTool.js', true))
      .FileReadTool
    ReadOff = (await importWithReadGlobs<ReadModule>('src/tools/FileReadTool/FileReadTool.js', false))
      .FileReadTool
    schemasOn = await importWithReadGlobs<Schemas>('src/tools/FileReadTool/schemas.js', true)
    schemasOff = await importWithReadGlobs<Schemas>('src/tools/FileReadTool/schemas.js', false)
  })

  afterAll(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  function context(): ToolUseContext {
    const toolPermissionContext = {
      ...getEmptyToolPermissionContext(),
      additionalWorkingDirectories: new Map([
        [project, { path: project, source: 'cliArg' as const }],
      ]),
    }
    return {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext }),
      options: {},
    } as unknown as ToolUseContext
  }

  async function resolve(input: Input): Promise<ResolvedInput<Input>> {
    const resolveInput = ReadOn.resolveInput
    if (!resolveInput) throw new Error('the flag-on Read has no resolveInput')
    return runWithCwdOverride(project, async () => resolveInput(input, context()))
  }

  function pathsOf(result: ResolvedInput<Input>): string[] | undefined {
    return result.ok ? result.input.file_paths : undefined
  }

  test('off, a Read has no resolveInput: every input reaches validateInput as sent', () => {
    expect(ReadOff.resolveInput).toBeUndefined()
  })

  test('`*` stays in its directory, relative or absolute', async () => {
    const expected = [join(project, 'src/a.ts'), join(project, 'src/b.ts')]
    expect(pathsOf(await resolve({ file_paths: ['src/*.ts'] }))).toEqual(expected)
    expect(pathsOf(await resolve({ file_paths: [join(project, 'src/*.ts')] }))).toEqual(expected)
  })

  test('`**` walks the tree the way git sees it: .gitignore respected', async () => {
    expect(pathsOf(await resolve({ file_paths: ['**/*.ts'] }))).toEqual([
      join(project, 'src/a.ts'),
      join(project, 'src/b.ts'),
      join(project, 'src/nested/c.ts'),
    ])
  })

  test('outside the working directories nothing is listed', async () => {
    expect(await resolve({ file_paths: [join(elsewhere, '*.ts')] })).toEqual({
      ok: false,
      message: `${join(elsewhere, '*.ts')}: globs in file_paths expand only inside the project — list ${elsewhere} with Glob first.`,
    })
  })

  test('over the cap the call is refused', async () => {
    expect(await resolve({ file_paths: ['many/*.txt'] })).toEqual({
      ok: false,
      message: `many/*.txt matches more than ${MAX_GLOB_FILES} files; Read takes ${MAX_GLOB_FILES} per call — narrow the pattern or split it.`,
    })
  })

  // The permission check parses the resolved input again with the tool's
  // schema (permissions.ts), so what the expansion hands on must parse under
  // the flag-on one — a single file and a full call alike.
  test('one file and the full cap both parse under the flag-on schema, which the default one refuses', async () => {
    const one = await resolve({ file_paths: ['src/a.*'] })
    expect(pathsOf(one)).toEqual([join(project, 'src/a.ts')])
    const full = await resolve({ file_paths: ['many/f0*.txt', 'many/f[1-4]*.txt'] })
    expect(pathsOf(full)).toHaveLength(MAX_GLOB_FILES)
    for (const result of [one, full]) {
      if (!result.ok) throw new Error(result.message)
      expect(schemasOn.inputSchema().safeParse(result.input).success).toBe(true)
    }
    if (one.ok) expect(schemasOff.inputSchema().safeParse(one.input).success).toBe(false)
  })

  test('validation and the permission check see the files, and allow them', async () => {
    const result = await resolve({ file_paths: ['src/*.ts', 'README.md'] })
    if (!result.ok) throw new Error(result.message)
    const ctx = context()
    expect(await ReadOn.validateInput!(result.input, ctx)).toEqual({ result: true })
    const decision = await ReadOn.checkPermissions(result.input, ctx)
    expect(decision.behavior).toBe('allow')
  })

  test('a link inside the project that leads out of it is not listed either', async () => {
    const link = join(project, 'out')
    symlinkSync(elsewhere, link)
    try {
      expect(await resolve({ file_paths: ['out/*.ts'] })).toEqual({
        ok: false,
        message: `out/*.ts: globs in file_paths expand only inside the project — list ${link} with Glob first.`,
      })
    } finally {
      unlinkSync(link)
    }
  })

  // The lexical check comes first so that a base outside the project is
  // refused before anything resolves its symlinks there.
  test('a glob outside the project is refused without touching the disk there', async () => {
    const touched: string[] = []
    const real = getFsImplementation()
    setFsImplementation(
      new Proxy(real, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            touched.push(String(args[0]))
            return value.apply(target, args)
          }
        },
      }),
    )
    try {
      expect((await resolve({ file_paths: [join(elsewhere, '*.ts')] })).ok).toBe(false)
    } finally {
      setFsImplementation(real)
    }
    expect(touched.filter(path => path.startsWith(elsewhere))).toEqual([])
  })

  test('a glob that names an existing file as written is that file', async () => {
    write('app/[slug]/page.tsx')
    expect(pathsOf(await resolve({ file_paths: ['app/[slug]/page.tsx'] }))).toEqual([
      'app/[slug]/page.tsx',
    ])
  })

  test('a glob that is no file name is not logged as an error', async () => {
    // logError records nothing at Claudin's default privacy level
    // (essential-traffic), so opt back in for the length of the test.
    const prior = process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    try {
      const before = getInMemoryErrors()
      expect(pathsOf(await resolve({ file_paths: [join(project, 'src/*.ts')] }))).toHaveLength(2)
      expect(getInMemoryErrors()).toEqual(before)
    } finally {
      if (prior === undefined) delete process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
      else process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = prior
    }
  })
})
