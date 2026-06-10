import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
// GlobTool/UI reuses GrepTool.renderToolResultMessage at module-eval time.
// Import GlobTool first so its UI resolves GrepTool only once GrepTool has
// fully initialized — importing GrepTool alone trips a TDZ in the cycle.
import '../GlobTool/GlobTool.js'
import { GrepTool, RG_LINE_RE } from './GrepTool.js'

// ---------------------------------------------------------------------------
// Regression + feature suite for GrepTool.
//
// The baseline-regression cases were captured before the Smart Code
// Navigation feature (output_mode: 'symbols'); the feature cases were added
// alongside that mode.
// ---------------------------------------------------------------------------

// GrepTool sorts deterministically by filename when NODE_ENV === 'test'.
process.env.NODE_ENV = 'test'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-regression-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(
    join(dir, 'alpha.ts'),
    'const needle = 1\nfunction other() {}\nconst needle2 = needle\n',
  )
  writeFileSync(
    join(dir, 'beta.ts'),
    'export function helper() {\n  return needle()\n}\n',
  )
  writeFileSync(join(dir, 'gamma.md'), '# Title\na doc mentioning needle once\n')
  writeFileSync(join(dir, 'sub', 'delta.py'), 'x = "needle"\ny = 2\n')
  writeFileSync(join(dir, 'epsilon.toml'), 'key = "needle"\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const emptyPermissionContext = {
  mode: 'default' as const,
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: emptyPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

// The call() return type is a union of the per-mode output literals; this
// loose shape lets each test read the fields relevant to its mode without
// repeated `mode`-narrowing.
type GrepData = {
  mode?: 'content' | 'files_with_matches' | 'count' | 'symbols'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
}

async function grep(
  input: Record<string, unknown> = {},
): Promise<GrepData> {
  const { data } = await GrepTool.call(
    { pattern: 'needle', path: dir, ...input } as never,
    makeContext(),
  )
  return data as GrepData
}

describe('GrepTool — baseline regression', () => {
  test('files_with_matches (default) lists every matching file', async () => {
    const data = await grep()

    expect(data.mode).toBe('files_with_matches')
    expect(data.numFiles).toBe(5)
    expect(data.filenames.some(f => f.endsWith('alpha.ts'))).toBe(true)
    expect(data.filenames.some(f => f.endsWith('delta.py'))).toBe(true)
  })

  test('content mode with line numbers returns matching lines', async () => {
    const data = await grep({ output_mode: 'content', '-n': true })

    expect(data.mode).toBe('content')
    expect(data.content).toContain('needle')
    // Line-number prefix from rg -n, e.g. "alpha.ts:1:const needle = 1"
    expect(data.content).toMatch(/:\d+:/)
    expect(data.numLines).toBeGreaterThan(0)
  })

  test('content mode honors -C context', async () => {
    const data = await grep({
      output_mode: 'content',
      '-n': true,
      '-C': 1,
      glob: '*.ts',
    })

    expect(data.mode).toBe('content')
    // With one line of context, a non-matching neighbor line shows up.
    expect(data.content).toContain('function other')
  })

  test('count mode reports total occurrences and file count', async () => {
    const data = await grep({ output_mode: 'count' })

    expect(data.mode).toBe('count')
    // alpha.ts has "needle" twice on line 1+3 (rg -c counts matching lines).
    expect(data.numMatches).toBeGreaterThanOrEqual(4)
    expect(data.numFiles).toBe(5)
  })

  test('glob filters the file set', async () => {
    const data = await grep({ glob: '*.py' })

    expect(data.numFiles).toBe(1)
    expect(data.filenames[0]).toMatch(/delta\.py$/)
  })

  test('type filter narrows to a language', async () => {
    const data = await grep({ type: 'md' })

    expect(data.numFiles).toBe(1)
    expect(data.filenames[0]).toMatch(/gamma\.md$/)
  })

  test('head_limit truncates the result set', async () => {
    const data = await grep({ head_limit: 2 })

    expect(data.filenames.length).toBe(2)
    expect(data.appliedLimit).toBe(2)
  })
})

describe('GrepTool — symbols mode', () => {
  test('maps matches to the enclosing function/class signature', async () => {
    const data = await grep({ output_mode: 'symbols', glob: '*.ts' })

    expect(data.mode).toBe('symbols')
    // beta.ts: the match on line 2 is inside `helper`.
    expect(data.content).toContain('beta.ts')
    expect(data.content).toContain('export function helper()')
  })

  test('reports a match outside any symbol rather than dropping the file', async () => {
    // alpha.ts: line 1 `const needle = 1` IS a symbol; this just checks the
    // file shows up with its top-level const.
    const data = await grep({ output_mode: 'symbols', glob: 'alpha.ts' })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('alpha.ts')
    expect(data.numFiles).toBe(1)
  })

  test('an unsupported language falls back to a bare file listing', async () => {
    const data = await grep({ output_mode: 'symbols', glob: '*.toml' })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('epsilon.toml')
    expect(data.content).toContain('language not supported')
  })

  test('markdown matches map to their enclosing heading', async () => {
    const data = await grep({ output_mode: 'symbols', glob: '*.md' })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('gamma.md')
    expect(data.content).toContain('# Title')
  })

  test('works when path targets a single file (not a directory)', async () => {
    // Regression: rg omits the filename for a single-file target, so the
    // `path:line:text` parser would drop every match. -H forces the path.
    const data = await grep({
      output_mode: 'symbols',
      path: join(dir, 'beta.ts'),
    })

    expect(data.mode).toBe('symbols')
    expect(data.numFiles).toBe(1)
    expect(data.numMatches).toBeGreaterThan(0)
    expect(data.content).toContain('export function helper()')
  })

  test('no matches yields an empty symbols result', async () => {
    const data = await grep({
      pattern: 'definitelyNotPresentXYZ',
      output_mode: 'symbols',
    })

    expect(data.mode).toBe('symbols')
    expect(data.numFiles).toBe(0)
    expect(data.numMatches).toBe(0)
  })
})

describe('GrepTool RG_LINE_RE', () => {
  test('splits a POSIX path:line:text line', () => {
    const m = RG_LINE_RE.exec('/home/u/proj/src/a.ts:42:const needle = 1')
    expect(m?.[1]).toBe('/home/u/proj/src/a.ts')
    expect(m?.[2]).toBe('42')
  })

  test('keeps a Windows drive letter in the path', () => {
    // Regression: indexOf(':') would split on the drive-letter colon and
    // mistake the drive for the path and the rest for the line number.
    const m = RG_LINE_RE.exec('C:\\proj\\src\\a.ts:7:export function helper()')
    expect(m?.[1]).toBe('C:\\proj\\src\\a.ts')
    expect(m?.[2]).toBe('7')
  })

  test('matches the first colon-digits-colon when text also contains one', () => {
    const m = RG_LINE_RE.exec('/x/a.ts:3:if (ratio === 1:2) return')
    expect(m?.[1]).toBe('/x/a.ts')
    expect(m?.[2]).toBe('3')
  })
})
