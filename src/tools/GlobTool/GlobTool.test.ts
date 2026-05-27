import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { GlobTool } from './GlobTool.js'

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'globtool-'))
  writeFileSync(join(workDir, 'a.ts'), '')
  writeFileSync(join(workDir, 'b.ts'), '')
  writeFileSync(join(workDir, 'c.js'), '')
  mkdirSync(join(workDir, 'nested'))
  writeFileSync(join(workDir, 'nested', 'd.ts'), '')
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
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
    globLimits: { maxResults: 100 },
  } as unknown as ToolUseContext
}

describe('GlobTool', () => {
  test('flags: read-only, concurrency-safe', () => {
    expect(GlobTool.isReadOnly?.()).toBe(true)
    expect(GlobTool.isConcurrencySafe?.()).toBe(true)
  })

  test('isSearchOrReadCommand classifies as search', () => {
    const cls = GlobTool.isSearchOrReadCommand?.({} as never)
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
      makeCtx(),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(1)
    }
  })

  test('validateInput rejects path that points to a file', async () => {
    const result = await GlobTool.validateInput?.(
      { pattern: '**/*', path: join(workDir, 'a.ts') } as never,
      makeCtx(),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(2)
    }
  })

  test('validateInput accepts an existing directory', async () => {
    const result = await GlobTool.validateInput?.(
      { pattern: '**/*.ts', path: workDir } as never,
      makeCtx(),
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
