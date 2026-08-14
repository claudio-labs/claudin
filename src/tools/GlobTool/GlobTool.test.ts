import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { GlobTool } from './GlobTool.js'

let workDir: string
// Files whose mtimes run oldest → newest in the opposite order of their names,
// so a ranking regression cannot be masked by an alphabetical sort.
let orderedDir: string
// 105 files: enough to prove the 100-path cap and the second page behind it.
let manyDir: string
const MANY_COUNT = 105

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'globtool-'))
  writeFileSync(join(workDir, 'a.ts'), '')
  writeFileSync(join(workDir, 'b.ts'), '')
  writeFileSync(join(workDir, 'c.js'), '')
  mkdirSync(join(workDir, 'nested'))
  writeFileSync(join(workDir, 'nested', 'd.ts'), '')

  orderedDir = mkdtempSync(join(tmpdir(), 'globtool-order-'))
  ;['a.ts', 'b.ts', 'c.ts'].forEach((name, i) => {
    const file = join(orderedDir, name)
    writeFileSync(file, '')
    const seconds = 1_000_000 + i * 10
    utimesSync(file, seconds, seconds)
  })

  manyDir = mkdtempSync(join(tmpdir(), 'globtool-many-'))
  for (let i = 1; i <= MANY_COUNT; i++) {
    const name = `f${String(i).padStart(3, '0')}.txt`
    const file = join(manyDir, name)
    writeFileSync(file, '')
    const seconds = 1_000_000 + i * 10
    utimesSync(file, seconds, seconds)
  }
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(orderedDir, { recursive: true, force: true })
  rmSync(manyDir, { recursive: true, force: true })
})

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: true,
      },
    }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('GlobTool', () => {
  test('flags: read-only, concurrency-safe', () => {
    expect(GlobTool.isReadOnly?.()).toBe(true)
    expect(GlobTool.isConcurrencySafe?.()).toBe(true)
  })

  test('isSearchOrReadCommand classifies as search', () => {
    const cls = GlobTool.isSearchOrReadCommand?.()
    expect(cls).toEqual({ isSearch: true, isRead: false })
  })

  test('input schema requires pattern and rejects unknown keys', () => {
    expect(GlobTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      GlobTool.inputSchema.safeParse({ pattern: '**/*.ts', extra: 1 }).success,
    ).toBe(false)
    expect(GlobTool.inputSchema.safeParse({ pattern: '**/*.ts' }).success).toBe(
      true,
    )
  })

  test('input schema accepts an offset', () => {
    expect(
      GlobTool.inputSchema.safeParse({ pattern: '**/*.ts', offset: 100 })
        .success,
    ).toBe(true)
  })

  test('validateInput rejects a negative offset', async () => {
    const result = await GlobTool.validateInput?.({
      pattern: '**/*',
      offset: -1,
    } as never)
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(3)
    }
  })

  test('toAutoClassifierInput returns the pattern', () => {
    expect(
      GlobTool.toAutoClassifierInput?.({ pattern: '**/*.ts' } as never),
    ).toBe('**/*.ts')
  })

  test('getActivityDescription frames a friendly progress text', () => {
    expect(GlobTool.getActivityDescription?.({} as never)).toBe('Finding files')
  })

  test('validateInput rejects non-existent path', async () => {
    const result = await GlobTool.validateInput?.(
      { pattern: '**/*', path: '/definitely/not/here/__nope__' } as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(1)
    }
  })

  test('validateInput rejects path that points to a file', async () => {
    const result = await GlobTool.validateInput?.(
      { pattern: '**/*', path: join(workDir, 'a.ts') } as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(2)
    }
  })

  test('validateInput accepts an existing directory', async () => {
    const result = await GlobTool.validateInput?.(
      { pattern: '**/*.ts', path: workDir } as never,
    )
    expect(result?.result).toBe(true)
  })

  test('call() finds matching files under the provided path', async () => {
    const { data } = await GlobTool.call(
      { pattern: '**/*.ts', path: workDir } as never,
      makeCtx(),
    )
    expect(data.numFiles).toBeGreaterThanOrEqual(3)
    expect(data.filenames.some(f => f.endsWith('a.ts'))).toBe(true)
    expect(data.filenames.some(f => f.endsWith('d.ts'))).toBe(true)
    expect(data.truncated).toBe(false)
  })

  test('call() ranks results most-recently-modified first', async () => {
    const { data } = await GlobTool.call(
      { pattern: '*.ts', path: orderedDir } as never,
      makeCtx(),
    )
    expect(data.filenames.map(f => basename(f))).toEqual([
      'c.ts',
      'b.ts',
      'a.ts',
    ])
  })

  test('call() caps the page at 100 paths and reports the next offset', async () => {
    const { data } = await GlobTool.call(
      { pattern: '*.txt', path: manyDir } as never,
      makeCtx(),
    )
    expect(data.numFiles).toBe(100)
    expect(data.truncated).toBe(true)
    expect(data.nextOffset).toBe(100)
    // The cap has to drop the OLDEST matches, not the newest.
    expect(basename(data.filenames[0]!)).toBe(`f${String(MANY_COUNT)}.txt`)
    expect(data.filenames.some(f => basename(f) === 'f001.txt')).toBe(false)
  })

  test('call() with the reported offset returns the remaining page', async () => {
    const { data } = await GlobTool.call(
      { pattern: '*.txt', path: manyDir, offset: 100 } as never,
      makeCtx(),
    )
    expect(data.filenames.map(f => basename(f))).toEqual([
      'f005.txt',
      'f004.txt',
      'f003.txt',
      'f002.txt',
      'f001.txt',
    ])
    expect(data.truncated).toBe(false)
    expect(data.nextOffset).toBeUndefined()
  })

  test('mapToolResultToToolResultBlockParam renders empty + truncated cases', () => {
    const map = GlobTool.mapToolResultToToolResultBlockParam
    const empty = map?.(
      { durationMs: 1, numFiles: 0, filenames: [], truncated: false },
      'u',
    )
    expect(empty?.content).toBe('No files found')

    const truncated = map?.(
      {
        durationMs: 1,
        numFiles: 1,
        filenames: ['a.ts'],
        truncated: true,
      },
      'u',
    )
    expect(truncated?.content).toContain('a.ts')
    expect(truncated?.content).toContain('truncated')
  })

  test('the truncation notice hands back the offset to page with', () => {
    const content = GlobTool.mapToolResultToToolResultBlockParam?.(
      {
        durationMs: 1,
        numFiles: 1,
        filenames: ['a.ts'],
        truncated: true,
        nextOffset: 100,
      },
      'u',
    )?.content as string

    expect(content).toContain('offset=100')
    // summarizeGlobOutput tells the notice apart from a path by this prefix.
    expect(content.split('\n').at(-1)).toMatch(/^\(Results are truncated/)
  })

  test('an unfinished walk is reported, with or without paths', () => {
    const map = GlobTool.mapToolResultToToolResultBlockParam

    // Zero paths is exactly where it matters most: a walk that was cut short
    // never established that nothing matches.
    const empty = map?.(
      {
        durationMs: 1,
        numFiles: 0,
        filenames: [],
        truncated: false,
        incomplete: 'timeout',
      },
      'u',
    )?.content as string
    expect(empty).toContain('No files found')
    expect(empty).toContain('INCOMPLETE')

    const buffered = map?.(
      {
        durationMs: 1,
        numFiles: 1,
        filenames: ['a.ts'],
        truncated: false,
        incomplete: 'buffer',
      },
      'u',
    )?.content as string
    expect(buffered).toContain('a.ts')
    expect(buffered).toContain('more output than could be buffered')

    // A finished walk says nothing, so the note cannot become background noise.
    const complete = map?.(
      { durationMs: 1, numFiles: 1, filenames: ['a.ts'], truncated: false },
      'u',
    )?.content as string
    expect(complete).not.toContain('INCOMPLETE')
  })

  test('extractSearchText joins filenames with newlines', () => {
    expect(
      GlobTool.extractSearchText?.({
        durationMs: 0,
        numFiles: 2,
        filenames: ['a.ts', 'b.ts'],
        truncated: false,
      }),
    ).toBe('a.ts\nb.ts')
  })
})
