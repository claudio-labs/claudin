import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
// GlobTool/UI reuses GrepTool.renderToolResultMessage at module-eval time.
// Import GlobTool first so its UI resolves GrepTool only once GrepTool has
// fully initialized — importing GrepTool alone trips a TDZ in the cycle.
import '../GlobTool/GlobTool.js'
import { GrepTool, RG_LINE_RE, relativizeRgLine } from './GrepTool.js'

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
  writeFileSync(join(dir, 'epsilon.csv'), 'key,needle\n')
  // A Ruby fixture for the new-language symbols path. It deliberately does NOT
  // contain "needle" (the default pattern) so the file-count baselines above
  // stay at 5; the symbols test below searches its own token.
  writeFileSync(
    join(dir, 'zeta.rb'),
    'class Worker\n  def process\n    harvest_all\n  end\nend\n',
  )
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
    const data = await grep({ output_mode: 'symbols', glob: '*.csv' })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('epsilon.csv')
    expect(data.content).toContain('language not supported')
  })

  test('markdown matches map to their enclosing heading', async () => {
    const data = await grep({ output_mode: 'symbols', glob: '*.md' })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('gamma.md')
    expect(data.content).toContain('# Title')
  })

  test('resolves the enclosing symbol in a new-language file (Ruby)', async () => {
    const data = await grep({
      output_mode: 'symbols',
      glob: '*.rb',
      pattern: 'harvest_all',
    })

    expect(data.mode).toBe('symbols')
    expect(data.content).toContain('zeta.rb')
    // The match on line 3 sits inside the `process` method of `Worker`.
    expect(data.content).toContain('def process')
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

  test('a file over the scan byte cap is skipped, not read', async () => {
    // A file over SCAN_MAX_BYTES (10 MB) must be stat-and-skipped instead of
    // read whole into memory. Built from a single newline-filled buffer (real
    // text so ripgrep matches line 1, but one cheap native allocation).
    const big = join(dir, 'omega.rb')
    const pad = Buffer.alloc(11 * 1024 * 1024, 0x0a)
    writeFileSync(big, Buffer.concat([Buffer.from('def giant_hook\nend\n'), pad]))
    try {
      const data = await grep({
        output_mode: 'symbols',
        glob: '*.rb',
        pattern: 'giant_hook',
      })

      expect(data.mode).toBe('symbols')
      expect(data.content).toContain('omega.rb')
      expect(data.content).toContain('file too large to scan')
    } finally {
      rmSync(big, { force: true })
    }
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

describe('GrepTool relativizeRgLine', () => {
  // rg is invoked with an absolute target derived from getCwd(), so every
  // prefixed line starts with that — and relativizing is anchored to the same
  // value. NOT process.cwd(): the session cwd is realpath-resolved at startup
  // (bootstrap/state.ts), so on a checkout reached through a symlink the two
  // differ, every candidate lands outside the anchor, and the function
  // correctly fails open on input the tool would never produce. That is what
  // broke this block on CI while it passed locally.
  const root = getCwd()

  test('relativizes a match line', () => {
    expect(relativizeRgLine(`${root}/src/a.ts:42:const needle = 1`, root)).toBe(
      'src/a.ts:42:const needle = 1',
    )
  })

  test('relativizes a context line whose text has no colon', () => {
    // The bug: indexOf(':') returned -1 here, so the whole absolute path was
    // kept — 30 wasted chars on every colon-less context line of every -C grep.
    expect(
      relativizeRgLine(`${root}/src/a.ts-791-const GREP_MAX_FILES = 50`, root),
    ).toBe('src/a.ts-791-const GREP_MAX_FILES = 50')
  })

  test('relativizes a context line whose text does contain a colon', () => {
    expect(
      relativizeRgLine(`${root}/src/a.ts-12-  // note: see below`, root),
    ).toBe('src/a.ts-12-  // note: see below')
  })

  test('keeps a Windows drive letter inside the path', () => {
    const line = 'C:\\proj\\src\\a.ts-7-export function helper()'
    expect(relativizeRgLine(line, 'C:\\proj')).toBe(
      // Outside cwd, so toRelativePath keeps it absolute — the point is that
      // the drive-letter colon was not mistaken for the separator.
      line,
    )
  })

  test('relativizes past a directory that contains a separator run', () => {
    // A directory named `foo-12-bar` makes the first split land inside the
    // path. Rewriting THAT would point at a file that does not exist, so the
    // guard rejects it — and the walk moves on to the next candidate instead of
    // giving up, which is what used to leak the absolute path on every line of
    // a search rooted in a directory like `proj-2026-q1`.
    const line = `${root}/foo-12-bar/a.ts-791-const X = 50`
    expect(relativizeRgLine(line, `${root}/foo-12-bar`)).toBe(
      'foo-12-bar/a.ts-791-const X = 50',
    )
  })

  test('relativizes a file whose own name contains a separator run', () => {
    const line = `${root}/notes/report-2026-07-25.md:12:const X = 50`
    expect(relativizeRgLine(line, root)).toBe(
      'notes/report-2026-07-25.md:12:const X = 50',
    )
  })

  test('still gives up when no candidate is under the search root', () => {
    const line = '/elsewhere/a.ts-791-const X = 50'
    expect(relativizeRgLine(line, `${root}/src`)).toBe(line)
  })

  test('leaves the block separator and unprefixed lines alone', () => {
    expect(relativizeRgLine('--', root)).toBe('--')
    expect(relativizeRgLine('117:const DEFAULT = 250', root)).toBe(
      '117:const DEFAULT = 250',
    )
  })

  test('still relativizes the -n:false form, which has no line number', () => {
    expect(relativizeRgLine(`${root}/src/a.ts:const needle = 1`, root)).toBe(
      'src/a.ts:const needle = 1',
    )
  })

  test('end-to-end: a -C search inside cwd leaks no absolute path', async () => {
    // Searches the repo itself (not the tmp fixture dir) because
    // toRelativePath deliberately keeps paths outside cwd absolute.
    const { data } = await GrepTool.call(
      {
        pattern: 'GREP_MAX_FILES',
        path: `${root}/src/utils`,
        output_mode: 'content',
        '-C': 1,
      } as never,
      makeContext(),
    )
    const content = (data as GrepData).content ?? ''
    expect(content).toContain('toolResultSummarizer.ts-')
    expect(content).not.toContain(root)
  })
})
