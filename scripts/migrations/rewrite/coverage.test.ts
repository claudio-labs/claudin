import { describe, expect, test } from 'bun:test'
import { importersOf, isBelowTarget, parseLcov, resolveSpecifier, rowsFor, targetFor } from './coverage.js'

const LCOV = [
  'TN:',
  'SF:/repo/src/agent/repl/REPL.tsx',
  'FNF:10',
  'FNH:5',
  'LF:200',
  'LH:114',
  'end_of_record',
  'TN:',
  'SF:src/providers/oauth/client.ts',
  'FNF:0',
  'FNH:0',
  'LF:100',
  'LH:85',
  'end_of_record',
].join('\n')

describe('parseLcov', () => {
  test('keys each file by its path from the root, absolute or not', () => {
    const files = parseLcov(LCOV, '/repo')
    expect(files.get('src/agent/repl/REPL.tsx')).toEqual({ lines: 200, hit: 114, functions: 10, functionsHit: 5 })
    expect(files.get('src/providers/oauth/client.ts')).toEqual({ lines: 100, hit: 85, functions: 0, functionsHit: 0 })
  })
})

describe('targetFor', () => {
  test('uses the testing.md target of the slice, and 70% where it names none', () => {
    const paths = [
      'src/providers/oauth/client.ts',
      'src/shared/fs/paths.ts',
      'src/tools/BashTool/BashTool.tsx',
      'scripts/build/build.ts',
      'src/agent/repl/REPL.tsx',
    ]
    expect(paths.map(targetFor)).toEqual([80, 75, 70, 60, 70])
  })

  test('a bench has no target, so it is listed without failing the gate', () => {
    expect(targetFor('scripts/bench/perf/memory-e2e-bench.ts')).toBeNull()
    const [row] = rowsFor(['scripts/bench/perf/memory-e2e-bench.ts'], new Map())
    expect(isBelowTarget(row!)).toBe(false)
  })
})

describe('resolveSpecifier', () => {
  test('resolves the src alias and relative paths, without the extension', () => {
    expect(resolveSpecifier('src/a/b.ts', 'src/platform/bridge/index.js')).toBe('src/platform/bridge/index')
    expect(resolveSpecifier('src/a/b.ts', '../platform/bridge.js')).toBe('src/platform/bridge')
    expect(resolveSpecifier('src/a/b.ts', './c.tsx')).toBe('src/a/c')
  })

  test('a package is not a repository path', () => {
    expect(resolveSpecifier('src/a/b.ts', 'react')).toBeNull()
    expect(resolveSpecifier('src/a/b.ts', '@anthropic-ai/sdk')).toBeNull()
  })
})

describe('importersOf', () => {
  const sources = new Map([
    ['src/agent/repl/REPL.tsx', "import { bridge } from 'src/platform/bridge/index.js'"],
    ['src/platform/headless/print.ts', "const m = await import('../bridge/session.js')"],
    ['src/platform/main/init.ts', "import 'src/platform/teleport.js'"],
    ['src/platform/bridge/inner.ts', "import { x } from 'src/platform/bridge/index.js'"],
    ['src/agent/repl/REPL.test.tsx', "import { x } from 'src/platform/bridge/index.js'"],
    ['src/platform/other.ts', "import { y } from 'src/platform/bridgeLike/other.js'"],
    ['src/tools/tools.ts', "import { z } from 'zod'"],
  ])

  test('lists the production files outside the cut that import into it, and no test', () => {
    expect(importersOf(['src/platform/bridge', 'src/platform/teleport.ts'], sources)).toEqual([
      'src/agent/repl/REPL.tsx',
      'src/platform/headless/print.ts',
      'src/platform/main/init.ts',
    ])
  })

  test('a relative import resolves from the importer, not from the root', () => {
    const relativeSources = new Map([
      ['src/platform/x.ts', "import x from './bridge/session.js'"],
      ['src/other/y.ts', "import y from '../bridge/session.js'"],
    ])
    expect(importersOf(['src/platform/bridge'], relativeSources)).toEqual(['src/platform/x.ts'])
  })

  test('a path that only shares a prefix with the cut is not inside it', () => {
    expect(importersOf(['src/platform/bridge'], sources)).not.toContain('src/platform/other.ts')
  })
})

describe('rowsFor', () => {
  const coverage = parseLcov(LCOV, '/repo')

  test('a file no test loads is below target, at the top', () => {
    const rows = rowsFor(['src/agent/repl/REPL.tsx', 'src/platform/main/init.ts'], coverage)
    expect(rows.map(r => [r.path, r.percent])).toEqual([
      ['src/platform/main/init.ts', null],
      ['src/agent/repl/REPL.tsx', 57],
    ])
    expect(rows.every(isBelowTarget)).toBe(true)
  })

  test('a file at or over its target passes', () => {
    const [row] = rowsFor(['src/providers/oauth/client.ts'], coverage)
    expect(row).toEqual({ path: 'src/providers/oauth/client.ts', percent: 85, functionPercent: null, target: 80 })
    expect(isBelowTarget(row!)).toBe(false)
  })
})
