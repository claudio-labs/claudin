import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/Tool.js'
import { runWithCwdOverride } from 'src/utils/fs/cwd.js'
import { FileStateCache } from 'src/utils/fs/fileStateCache.js'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from 'src/utils/fs/fsOperations.js'
import {
  checkRenamePermissions,
  type RenameInput,
  rewriteSource,
  runRename,
  summarizeRename,
} from './rename.js'

beforeAll(() => {
  // Defend against an fs mock leaked from another test file in the shard.
  setOriginalFsImplementation()
})

let dir: string
let ctx: ToolUseContext

function makeContext(mode?: 'bypassPermissions'): ToolUseContext {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    ...(mode ? { mode } : {}),
  }
  return {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
  } as unknown as ToolUseContext
}

function write(rel: string, body: string): string {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

// Mirrors the harness: the permission pass runs first and records the file set
// `call()` checks the write against. `runRename` fails closed without it, so a
// test that skipped this would be exercising a path production never takes.
function rename(input: RenameInput): ReturnType<typeof runRename> {
  return runWithCwdOverride(dir, async () => {
    await checkRenamePermissions(input, ctx)
    return runRename(input, ctx, randomUUID())
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rename-'))
  // An apply only reaches `call()` after the permission pass allowed it, so
  // these tests model an allowed call. Prompting behavior itself is covered in
  // RenameTool.permissions.test.ts.
  ctx = makeContext('bypassPermissions')
})

afterEach(() => {
  setOriginalFsImplementation()
  rmSync(dir, { recursive: true, force: true })
})

describe('rewriteSource', () => {
  test('splices every offset without shifting the later ones', () => {
    const src = 'cfg + cfg + cfg'
    expect(rewriteSource(src, [0, 6, 12], 'cfg', 'configuration')).toBe(
      'configuration + configuration + configuration',
    )
  })

  test('a shorter replacement keeps the untouched text intact', () => {
    const src = 'aa(longName) + longName'
    expect(rewriteSource(src, [3, 15], 'longName', 'x')).toBe('aa(x) + x')
  })

  // Discovery and the rewrite read the file separately. If it moved in
  // between, the offsets point at the wrong bytes — splicing them would
  // corrupt the file, so the batch has to abort instead.
  test('throws when an offset no longer holds the symbol', () => {
    expect(() => rewriteSource('cfg + xxx', [0, 6], 'cfg', 'x')).toThrow(
      'no longer holds',
    )
  })

  test('an empty offset list returns the source untouched', () => {
    expect(rewriteSource('cfg', [], 'cfg', 'x')).toBe('cfg')
  })
})

describe('runRename — apply', () => {
  test('renames every code site and leaves strings/comments alone', async () => {
    const a = write(
      'src/a.ts',
      [
        'export function cfg() {',
        '  return 1 // cfg stays',
        '}',
        'const label = "cfg stays"',
        'export const used = cfg()',
        '',
      ].join('\n'),
    )
    const b = write('src/b.ts', 'import { cfg } from "./a.js"\nconst cfgX = cfg\n')

    const { output } = await rename({ symbol: 'cfg', replacement: 'config' })

    expect(readFileSync(a, 'utf8')).toBe(
      [
        'export function config() {',
        '  return 1 // cfg stays',
        '}',
        'const label = "cfg stays"',
        'export const used = config()',
        '',
      ].join('\n'),
    )
    expect(readFileSync(b, 'utf8')).toBe(
      'import { config } from "./a.js"\nconst cfgX = config\n',
    )
    expect(output).toMatchObject({
      type: 'apply',
      siteCount: 4,
      skippedMasked: 2,
    })
  })

  test('marks rewritten files as a partial view — the model never saw them', async () => {
    const a = write('src/a.ts', 'export const cfg = 1\n')

    await rename({ symbol: 'cfg', replacement: 'config' })

    expect(ctx.readFileState.get(a)?.isPartialView).toBe(true)
  })

  test('reports zero sites without touching anything', async () => {
    const a = write('src/a.ts', 'const other = 1\n')

    const { output } = await rename({ symbol: 'cfg', replacement: 'config' })

    expect(output).toMatchObject({ type: 'apply', siteCount: 0, files: [] })
    expect(readFileSync(a, 'utf8')).toBe('const other = 1\n')
  })

  test('scope keeps files outside it untouched', async () => {
    write('src/a.ts', 'export const cfg = 1\n')
    const b = write('other/b.ts', 'export const cfg = 2\n')

    await rename({ symbol: 'cfg', replacement: 'config', scope: '**/src/**' })

    expect(readFileSync(b, 'utf8')).toBe('export const cfg = 2\n')
  })
})

describe('runRename — preview', () => {
  test('writes nothing and returns the site list plus a token', async () => {
    const a = write('src/a.ts', 'export function cfg() {\n  return cfg\n}\n')

    const { output } = await rename({
      symbol: 'cfg',
      replacement: 'config',
      mode: 'preview',
    })

    expect(readFileSync(a, 'utf8')).toContain('function cfg()')
    expect(output.type).toBe('preview')
    if (output.type !== 'preview') throw new Error('unreachable')
    expect(output.siteCount).toBe(2)
    expect(output.text).toMatch(/sitesToken: [0-9a-f]{12}/)
  })
})

describe('runRename — exclude', () => {
  async function previewToken(): Promise<string> {
    const { output } = await rename({
      symbol: 'cfg',
      replacement: 'config',
      mode: 'preview',
    })
    if (output.type !== 'preview') throw new Error('unreachable')
    return /sitesToken: ([0-9a-f]{12})/.exec(output.text)![1]!
  }

  test('skips the excluded site and renames the rest', async () => {
    const a = write('src/a.ts', 'export const cfg = 1\nexport const two = cfg\n')

    const sitesToken = await previewToken()
    const { output } = await rename({
      symbol: 'cfg',
      replacement: 'config',
      exclude: ['s01'],
      sitesToken,
    })

    expect(readFileSync(a, 'utf8')).toBe(
      'export const cfg = 1\nexport const two = config\n',
    )
    expect(output).toMatchObject({ siteCount: 1, excluded: 1 })
  })

  test('refuses a token from a stale preview', async () => {
    const a = write('src/a.ts', 'export const cfg = 1\nexport const two = cfg\n')
    const sitesToken = await previewToken()
    writeFileSync(a, 'const inserted = 1\nexport const cfg = 1\nexport const two = cfg\n')

    await expect(
      rename({
        symbol: 'cfg',
        replacement: 'config',
        exclude: ['s01'],
        sitesToken,
      }),
    ).rejects.toThrow(/tree changed/)
    expect(readFileSync(a, 'utf8')).toContain('export const cfg = 1')
  })

  test('refuses an id that no site carries', async () => {
    write('src/a.ts', 'export const cfg = 1\n')
    const sitesToken = await previewToken()

    await expect(
      rename({
        symbol: 'cfg',
        replacement: 'config',
        exclude: ['s99'],
        sitesToken,
      }),
    ).rejects.toThrow(/no such site id/)
  })
})

describe('runRename — atomicity', () => {
  test('rolls back every earlier file when the batch fails partway', async () => {
    const a = write('src/a.ts', 'export const cfg = 1\n')
    const b = write('src/b.ts', 'export const cfg = 2\n')
    // Interrupt the commit right after the first file lands, so the second
    // file's turn aborts with one write already on disk.
    const real = getFsImplementation()
    let aborted = false
    setFsImplementation({
      ...real,
      renameSync: ((from: string, to: string) => {
        const result = real.renameSync(from, to)
        if (!aborted && to === a) {
          aborted = true
          ctx.abortController.abort()
        }
        return result
      }) as typeof real.renameSync,
    })

    await expect(rename({ symbol: 'cfg', replacement: 'config' })).rejects.toThrow()

    setOriginalFsImplementation()
    expect(readFileSync(a, 'utf8')).toBe('export const cfg = 1\n')
    expect(readFileSync(b, 'utf8')).toBe('export const cfg = 2\n')
  })

  test('refuses to write a file that appeared after the approval', async () => {
    ctx = makeContext('bypassPermissions')
    const a = write('src/a.ts', 'export const cfg = 1\n')
    const input: RenameInput = { symbol: 'cfg', replacement: 'config' }

    const decision = await runWithCwdOverride(dir, () =>
      checkRenamePermissions(input, ctx),
    )
    expect(decision.behavior).toBe('allow')

    // A concurrent edit introduces a new match between approval and execution.
    const late = write('src/late.ts', 'export const cfg = 3\n')

    // Deliberately NOT the `rename` helper: it re-runs the permission pass,
    // which would approve the late file and erase the drift under test.
    await expect(
      runWithCwdOverride(dir, () => runRename(input, ctx, randomUUID())),
    ).rejects.toThrow(/after this call was approved/)
    expect(readFileSync(a, 'utf8')).toBe('export const cfg = 1\n')
    expect(readFileSync(late, 'utf8')).toBe('export const cfg = 3\n')
  })

  test('refuses to write when no approval is on record', async () => {
    ctx = makeContext('bypassPermissions')
    const a = write('src/a.ts', 'export const cfg = 1\n')

    // `call()` reached without a completed permission pass — the file set the
    // write should be checked against does not exist, so it must fail closed.
    await expect(
      runWithCwdOverride(dir, () =>
        runRename({ symbol: 'cfg', replacement: 'config' }, ctx, randomUUID()),
      ),
    ).rejects.toThrow(/no longer on record/)
    expect(readFileSync(a, 'utf8')).toBe('export const cfg = 1\n')
  })

  // The offsets are computed against one read of the file. If staging re-reads
  // and stores THAT as the base, the commit-time modification check compares a
  // fresh snapshot with itself and quietly overwrites the concurrent edit.
  test('an edit landing after the offsets were computed is not overwritten', async () => {
    const a = write('src/a.ts', 'export const cfg = 1\n')
    const input: RenameInput = { symbol: 'cfg', replacement: 'config' }
    await runWithCwdOverride(dir, () => checkRenamePermissions(input, ctx))

    // Land a concurrent edit immediately after the rename reads the file to
    // build its new content — i.e. inside the window the staged base must pin.
    const real = getFsImplementation()
    let swapped = false
    setFsImplementation({
      ...real,
      readFileSync: ((path: string, opts: unknown) => {
        const out = real.readFileSync(path, opts as never)
        if (!swapped && String(path) === a) {
          swapped = true
          writeFileSync(a, 'export const cfg = 99\n')
        }
        return out
      }) as typeof real.readFileSync,
    })

    await expect(
      runWithCwdOverride(dir, () => runRename(input, ctx, randomUUID())),
    ).rejects.toThrow()
    setOriginalFsImplementation()
    expect(readFileSync(a, 'utf8')).toBe('export const cfg = 99\n')
  })
})

// summarizeRename is the entire model-facing result of an apply: whatever it
// omits, the model never learns. The two caveats below are invisible in the
// file list, so they are the ones worth pinning.
describe('summarizeRename', () => {
  const base = {
    type: 'apply' as const,
    symbol: 'cfg',
    replacement: 'config',
    files: [
      {
        relPath: 'src/a.ts',
        sites: 2,
        absPath: '/repo/src/a.ts',
        structuredPatch: [],
        additions: 2,
        deletions: 2,
      },
    ],
    siteCount: 2,
    excluded: 0,
    skippedMasked: 0,
    unparsedFiles: [],
    unreadable: [],
  }

  test('lists every file with its site count', () => {
    const text = summarizeRename(base)

    expect(text).toContain('Renamed "cfg" → "config" at 2 site(s) in 1 file(s)')
    expect(text).toContain('src/a.ts  2 site(s)')
  })

  test('an unparsed file is named, because its strings were renamed too', () => {
    const text = summarizeRename({ ...base, unparsedFiles: ['notes.md'] })

    expect(text).toContain('notes.md')
    expect(text).toMatch(/strings and comments there WERE renamed/)
  })

  test('an unreadable candidate is reported, not silently dropped', () => {
    const text = summarizeRename({ ...base, unreadable: ['src/locked.ts'] })

    expect(text).toContain('src/locked.ts')
    expect(text).toMatch(/left untouched/)
  })

  test('a no-op apply says so and carries the exclusion count', () => {
    expect(
      summarizeRename({ ...base, files: [], siteCount: 0, excluded: 3 }),
    ).toBe('No site was renamed (3 excluded).')
  })
})
