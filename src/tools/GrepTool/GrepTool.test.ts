import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import type { ToolUseContext } from 'src/Tool.js'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
// GlobTool/UI reuses GrepTool.renderToolResultMessage at module-eval time.
// Import GlobTool first so its UI resolves GrepTool only once GrepTool has
// fully initialized — importing GrepTool alone trips a TDZ in the cycle.
import 'src/tools/GlobTool/GlobTool.js'
import { GrepTool, RG_LINE_RE, relativizeRgLine } from 'src/tools/GrepTool/GrepTool.js'

// ---------------------------------------------------------------------------
// Regression + feature suite for GrepTool.
//
// The baseline-regression cases were captured before the Smart Code
// Navigation feature (output_mode: 'symbols'); the feature cases were added
// alongside that mode.
// ---------------------------------------------------------------------------

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
  autoPivot?: boolean
  totalMatchLines?: number
  totalMatchFiles?: number
  ignoredOnly?: boolean
  incomplete?: 'timeout' | 'buffer'
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

describe('GrepTool — files_with_matches ranking', () => {
  let rankDir: string

  // The newest file sorts LAST alphabetically, so a filename sort produces the
  // exact inverse of the expected order — a ranking that silently falls back to
  // the tiebreaker cannot pass these by accident.
  beforeAll(() => {
    rankDir = mkdtempSync(join(tmpdir(), 'grep-ranking-'))
    ;['alpha.ts', 'mike.ts', 'zulu.ts'].forEach((name, i) => {
      const file = join(rankDir, name)
      writeFileSync(file, 'const needle = 1\n')
      const seconds = 1_000_000 + i * 10
      utimesSync(file, seconds, seconds)
    })
  })

  afterAll(() => {
    rmSync(rankDir, { recursive: true, force: true })
  })

  async function rank(input: Record<string, unknown> = {}): Promise<string[]> {
    const { data } = await GrepTool.call(
      { pattern: 'needle', path: rankDir, ...input } as never,
      makeContext(),
    )
    return (data as GrepData).filenames.map(f => basename(f))
  }

  test('lists the most recently modified match first', async () => {
    expect(await rank()).toEqual(['zulu.ts', 'mike.ts', 'alpha.ts'])
  })

  test('head_limit keeps the most recently modified matches', async () => {
    expect(await rank({ head_limit: 2 })).toEqual(['zulu.ts', 'mike.ts'])
  })

  test('offset pages down the same ranking', async () => {
    expect(await rank({ head_limit: 2, offset: 1 })).toEqual([
      'mike.ts',
      'alpha.ts',
    ])
  })
})

describe('GrepTool — context flags', () => {
  test('context wins over its -C alias', async () => {
    const data = await grep({
      output_mode: 'content',
      '-n': true,
      glob: '*.ts',
      context: 0,
      '-C': 5,
    })

    // With -C 5 the neighbor line would be in the output; context: 0 wins.
    expect(data.content).toContain('needle')
    expect(data.content).not.toContain('function other')
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

// ---------------------------------------------------------------------------
// GREP_AUTO_PIVOT: a broad content search comes back as the symbol map.
// The gate itself is unit-tested in autoPivot.test.ts; these cases pin the
// wiring — that the tool honours it, that every suppression reaches it, and
// that the rendered tool_result carries the footer.
// ---------------------------------------------------------------------------
describe('GrepTool — auto-pivot on a broad search', () => {
  let wideDir: string
  let hugeDir: string
  let noWinDir: string
  const prevForce = process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
  const prevCache = process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE

  /** `files` modules, 4 functions each, 3 lines per body carrying the token. */
  function makeModules(root: string, files: number): void {
    for (let f = 0; f < files; f++) {
      const fns: string[] = []
      for (let n = 0; n < 4; n++) {
        fns.push(
          `export function handler${f}_${n}(input: string): string {\n` +
            `  const widetoken = input\n` +
            `  const again = widetoken + widetoken\n` +
            `  return widetoken.concat(again)\n` +
            `}\n`,
        )
      }
      writeFileSync(join(root, `mod${f}.ts`), fns.join('\n'))
    }
  }

  beforeAll(() => {
    process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = '1'
    // buildTool wraps Grep in the 30s tool-result cache, keyed on the input
    // alone — without this, every test below that repeats an input replays the
    // FIRST test's pivoted result instead of exercising its own gate (which is
    // also why flipping the killswitch mid-session only takes effect for
    // inputs the cache has not already answered).
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
    wideDir = mkdtempSync(join(tmpdir(), 'grep-pivot-'))
    // 8 files × 4 functions × 3 hits = 96 match lines over 8 files: past the
    // match-line trigger and the file floor, under the 250 head_limit (so the
    // whole set is mapped, which keeps the per-file assertions independent of
    // ripgrep's traversal order), and dense enough per symbol that the map is
    // a fraction of the lines.
    makeModules(wideDir, 8)

    // 24 files → 288 match lines, past the default head_limit, so the pivot
    // has to report how much it did not map.
    hugeDir = mkdtempSync(join(tmpdir(), 'grep-pivot-huge-'))
    makeModules(hugeDir, 24)

    // Wide and dense enough to open the gate, but every hit sits in its own
    // long-signature function — so one match line maps to one much longer
    // symbol line and the map is BIGGER than the lines it would replace.
    noWinDir = mkdtempSync(join(tmpdir(), 'grep-pivot-nowin-'))
    for (let f = 0; f < 6; f++) {
      const fns: string[] = []
      for (let n = 0; n < 12; n++) {
        fns.push(
          `export async function extremelyDescriptiveHandlerName${f}_${n}(` +
            `request: IncomingRequestEnvelope, context: ExecutionContext, ` +
            `options: HandlerOptions = defaultHandlerOptions): Promise<HandlerOutcome> {\n` +
            `  widetoken()\n` +
            `}\n`,
        )
      }
      writeFileSync(join(noWinDir, `mod${f}.ts`), fns.join('\n'))
    }
  })

  afterAll(() => {
    if (prevForce === undefined) {
      delete process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
    } else {
      process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = prevForce
    }
    if (prevCache === undefined) {
      delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    } else {
      process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = prevCache
    }
    rmSync(wideDir, { recursive: true, force: true })
    rmSync(hugeDir, { recursive: true, force: true })
    rmSync(noWinDir, { recursive: true, force: true })
  })

  async function wideGrep(input: Record<string, unknown> = {}): Promise<GrepData> {
    const { data } = await GrepTool.call(
      {
        pattern: 'widetoken',
        path: wideDir,
        output_mode: 'content',
        ...input,
      } as never,
      makeContext(),
    )
    return data as GrepData
  }

  test('returns the symbol map instead of the matching lines', async () => {
    const data = await wideGrep()

    expect(data.mode).toBe('symbols')
    expect(data.autoPivot).toBe(true)
    expect(data.content).toContain('handler0_0')
    // The map dedupes by symbol: 4 hits inside one function collapse to a line.
    expect(data.numMatches).toBe(32)
    expect(data.numFiles).toBe(8)
  })

  test('reports how wide the search actually was', async () => {
    const data = await wideGrep()

    // 3 lines per function body carry the token, 4 functions, 8 files.
    expect(data.totalMatchLines).toBe(96)
    expect(data.totalMatchFiles).toBe(8)
  })

  test('the rendered result carries the opt-out footer', async () => {
    const data = await wideGrep()
    const block = GrepTool.mapToolResultToToolResultBlockParam(
      data as never,
      'tool-use-1',
    )

    expect(String(block.content)).toContain('Re-run with head_limit set')
  })

  test('a truncated pivot reports the part it did not map', async () => {
    const { data } = await GrepTool.call(
      { pattern: 'widetoken', path: hugeDir, output_mode: 'content' } as never,
      makeContext(),
    )
    const pivoted = data as GrepData
    const block = GrepTool.mapToolResultToToolResultBlockParam(
      pivoted as never,
      'tool-use-2',
    )

    expect(pivoted.mode).toBe('symbols')
    expect(pivoted.appliedLimit).toBe(250)
    expect(pivoted.totalMatchLines).toBe(288)
    expect(pivoted.totalMatchFiles).toBe(24)
    expect(String(block.content)).toContain(
      'The search matched 288 lines in 24 files; the first 250 are mapped below.',
    )
  })

  test('a map that is not materially smaller keeps the lines', async () => {
    const { data } = await GrepTool.call(
      { pattern: 'widetoken', path: noWinDir, output_mode: 'content' } as never,
      makeContext(),
    )

    expect((data as GrepData).mode).toBe('content')
  })

  test('an explicit head_limit keeps the lines', async () => {
    const data = await wideGrep({ head_limit: 200 })

    expect(data.mode).toBe('content')
    expect(data.numLines).toBe(96)
  })

  test('an offset keeps the lines', async () => {
    const data = await wideGrep({ offset: 10 })

    expect(data.mode).toBe('content')
  })

  test('-n: false keeps the lines', async () => {
    // Double-covered on purpose: the explicit suppression AND the fact that
    // `path:text` lines measure as zero files. Deleting the guard alone does
    // not make this fail — autoPivot.test.ts is what pins the guard itself.
    const data = await wideGrep({ '-n': false })

    expect(data.mode).toBe('content')
  })

  test('the killswitch keeps the lines', async () => {
    process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT = '1'
    try {
      const data = await wideGrep()
      expect(data.mode).toBe('content')
    } finally {
      delete process.env.CLAUDIN_DISABLE_GREP_AUTO_PIVOT
    }
  })

  test('a small search over the same file count keeps its lines', async () => {
    // The default fixture dir matches 5 files — at the file floor, but a few
    // dozen chars. Breadth alone must not pivot.
    const { data } = await GrepTool.call(
      { pattern: 'needle', path: dir, output_mode: 'content' } as never,
      makeContext(),
    )

    expect((data as GrepData).mode).toBe('content')
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
  // What this block needs is the ONE precondition production always satisfies:
  // the directory rg is pointed at and the directory relativizing is anchored
  // to are the same value. GrepTool derives both from getCwd(), so they cannot
  // drift there — but a test that reads either from the ambient environment
  // inherits whatever the runner's session cwd happens to be, and on CI that
  // is not the checkout. (Read from process.cwd() the candidates all landed
  // outside the anchor and the function correctly failed open; read from
  // getCwd() the search path did not exist and rg returned nothing.)
  //
  // So pin the anchor for the block and restore it after: bootstrap state is
  // process-global and bun runs test files in one process, so leaving it moved
  // would follow other files (see .claudin/rules/testing.md on mock leaks).
  const root = process.cwd()
  let previousCwdState: string

  beforeAll(() => {
    previousCwdState = getCwdState()
    setCwdState(root)
  })

  afterAll(() => {
    setCwdState(previousCwdState)
  })

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
        path: `${root}/src/agent/tools`,
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

// ---------------------------------------------------------------------------
// "Found nothing" vs "never looked": the four ways a search used to come back
// empty without saying why.
// ---------------------------------------------------------------------------

describe('GrepTool — blind spots', () => {
  let blindDir: string

  beforeAll(() => {
    blindDir = mkdtempSync(join(tmpdir(), 'grep-blind-'))
    mkdirSync(join(blindDir, 'hidden_from_vcs'), { recursive: true })
    // `.ignore` rather than `.gitignore` so the fixture needs no git repo:
    // ripgrep honors both, and the single `--no-ignore` flag under test turns
    // off both at once, so this exercises the identical code path.
    writeFileSync(join(blindDir, '.ignore'), 'hidden_from_vcs/\n')
    writeFileSync(
      join(blindDir, 'hidden_from_vcs', 'generated.ts'),
      'export const ZQBURIED = 1\n',
    )
    // A second buried symbol, searched by exactly one test below. The
    // tool-result cache keys on the input alone (wrapCallWithCache in
    // src/Tool.ts), so a test that re-runs an earlier test's search replays
    // that result and proves nothing about its own subject.
    writeFileSync(
      join(blindDir, 'hidden_from_vcs', 'other.ts'),
      'export const ZQSECONDHIDDEN = 9\n',
    )
    writeFileSync(join(blindDir, 'tracked.ts'), 'export const ZQTRACKED = 2\n')
    writeFileSync(join(blindDir, 'shouty.ts'), 'const ZQSHOUT = 3\n')
    // UTF-16LE without a BOM: ripgrep's default sniffing only recognizes a BOM,
    // so this reads as binary and is skipped unless `encoding` says otherwise.
    writeFileSync(
      join(blindDir, 'wide.txt'),
      Buffer.from('ZQWIDE = 4\n', 'utf16le'),
    )
    writeFileSync(
      join(blindDir, 'blob.dat'),
      Buffer.from([0x00, 0x01, ...Buffer.from('ZQBINARY'), 0x00]),
    )
  })

  afterAll(() => {
    rmSync(blindDir, { recursive: true, force: true })
  })

  async function blindGrep(input: Record<string, unknown>): Promise<GrepData> {
    const { data } = await GrepTool.call(
      { path: blindDir, ...input } as never,
      makeContext(),
    )
    return data as GrepData
  }

  test('a match that exists only in ignored files is found and labelled', async () => {
    const data = await blindGrep({ pattern: 'ZQBURIED' })

    expect(data.numFiles).toBe(1)
    expect(data.filenames[0]).toContain('generated.ts')
    // Without this the result is indistinguishable from an ordinary hit in a
    // tracked file, which is the whole point of running the second pass.
    expect(data.ignoredOnly).toBe(true)
  })

  test('a match in a tracked file does not trigger the ignored pass', async () => {
    const data = await blindGrep({ pattern: 'ZQTRACKED' })

    expect(data.numFiles).toBe(1)
    expect(data.ignoredOnly).toBeUndefined()
  })

  test('a pattern absent everywhere still reports nothing found', async () => {
    const data = await blindGrep({ pattern: 'ZQABSENTEVERYWHERE' })

    expect(data.numFiles).toBe(0)
    expect(data.ignoredOnly).toBeUndefined()
  })

  test('no_ignore searches ignored files on the first pass, unlabelled', async () => {
    const data = await blindGrep({ pattern: 'ZQBURIED', no_ignore: true })

    expect(data.numFiles).toBe(1)
    // Nothing to disclose: the caller asked for those files.
    expect(data.ignoredOnly).toBeUndefined()
  })

  test('CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK restores the silent miss', async () => {
    const previous = process.env.CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK
    process.env.CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK = '1'
    try {
      const data = await blindGrep({ pattern: 'ZQSECONDHIDDEN' })
      expect(data.numFiles).toBe(0)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK
      } else {
        process.env.CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK = previous
      }
    }
  })

  test('a lowercase pattern matches an uppercase symbol (smart-case)', async () => {
    const data = await blindGrep({ pattern: 'zqshout' })

    expect(data.numFiles).toBe(1)
    expect(data.filenames[0]).toContain('shouty.ts')
  })

  test('an uppercase pattern stays case-sensitive (smart-case)', async () => {
    // The other half of smart-case: adding an uppercase letter must NOT widen
    // the search, or the mode would just be -i under another name.
    const data = await blindGrep({ pattern: 'ZQShout' })

    expect(data.numFiles).toBe(0)
  })

  test('-i false forces case-sensitive matching', async () => {
    // What this pins is the three-way split: an explicit false must not fall
    // through to smart-case. It does NOT pin the --case-sensitive flag itself
    // — dropping that flag lands on ripgrep's own default and this still
    // passes, which is a no-op, not a guard.
    const data = await blindGrep({ pattern: 'zqshout', '-i': false })

    expect(data.numFiles).toBe(0)
  })

  test('-i true forces case-insensitive matching', async () => {
    const data = await blindGrep({ pattern: 'zqshout', '-i': true })

    expect(data.numFiles).toBe(1)
  })

  test('encoding reaches UTF-16 text that is otherwise skipped as binary', async () => {
    const without = await blindGrep({ pattern: 'ZQWIDE' })
    expect(without.numFiles).toBe(0)

    const withEncoding = await blindGrep({
      pattern: 'ZQWIDE',
      encoding: 'utf-16le',
    })
    expect(withEncoding.numFiles).toBe(1)
    expect(withEncoding.filenames[0]).toContain('wide.txt')
  })

  test('binary searches inside a binary file', async () => {
    const without = await blindGrep({ pattern: 'ZQBINARY' })
    expect(without.numFiles).toBe(0)

    const withBinary = await blindGrep({ pattern: 'ZQBINARY', binary: true })
    expect(withBinary.numFiles).toBe(1)
    expect(withBinary.filenames[0]).toContain('blob.dat')
  })

  test('an invalid regex is an error, not "no matches"', async () => {
    // The failure this replaces was silent: ripgrep exits 2 on a regex it
    // cannot parse, which used to resolve to an empty result set.
    await expect(blindGrep({ pattern: '[a-' })).rejects.toThrow(
      /regex parse error/,
    )
  })

  test('an unknown encoding label is an error, not "no matches"', async () => {
    await expect(
      blindGrep({ pattern: 'ZQWIDE', encoding: 'utf16' }),
    ).rejects.toThrow(/unknown encoding/)
  })
})

// ---------------------------------------------------------------------------
// outputSchema gates what the result renderer sees: a z.object strips any key
// it does not declare, so a field the renderer reads but the schema omits
// arrives as undefined, silently and only in the TUI. A formatter test cannot
// see that, which is why these parse the full result shape instead.
// ---------------------------------------------------------------------------

describe('GrepTool — outputSchema declares the search notes', () => {
  test('ignoredOnly survives a parse', () => {
    const parsed = GrepTool.outputSchema.parse({
      mode: 'files_with_matches',
      numFiles: 1,
      filenames: ['generated.ts'],
      ignoredOnly: true,
    })

    expect(parsed.ignoredOnly).toBe(true)
  })

  test('incomplete survives a parse in both of its forms', () => {
    for (const reason of ['timeout', 'buffer'] as const) {
      const parsed = GrepTool.outputSchema.parse({
        mode: 'content',
        numFiles: 0,
        filenames: [],
        content: 'a.ts:1:hit',
        incomplete: reason,
      })
      expect(parsed.incomplete).toBe(reason)
    }
  })
})

// ---------------------------------------------------------------------------
// The rendered result — what the model actually reads.
// ---------------------------------------------------------------------------

describe('GrepTool — search notes reach the tool result', () => {
  function render(output: Record<string, unknown>): string {
    const block = GrepTool.mapToolResultToToolResultBlockParam!(
      output as never,
      'tool-use-1',
    )
    return typeof block.content === 'string' ? block.content : ''
  }

  test('the ignored-files note states the measured count, not a possibility', () => {
    const text = render({
      mode: 'files_with_matches',
      numFiles: 2,
      filenames: ['dist/a.js', 'dist/b.js'],
      ignoredOnly: true,
    })

    expect(text).toContain('No matches in tracked files')
    expect(text).toContain('The 2 files below')
    expect(text).toContain('no_ignore: true')
    expect(text).toContain('dist/a.js')
  })

  test('the incomplete note names the cause and the way out', () => {
    const text = render({
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: 'a.ts:1:hit',
      numLines: 1,
      incomplete: 'timeout',
    })

    expect(text).toContain('INCOMPLETE')
    expect(text).toContain('not all of them')
    expect(text).toContain('a.ts:1:hit')
  })

  test('a plain result carries neither note', () => {
    const text = render({
      mode: 'files_with_matches',
      numFiles: 1,
      filenames: ['src/a.ts'],
    })

    expect(text).not.toContain('INCOMPLETE')
    expect(text).not.toContain('no_ignore')
  })
})

// ---------------------------------------------------------------------------
// symbols mode over a non-UTF-8 file. Finding the match was only half the
// answer: the scan that maps a match to its enclosing function opens the file
// itself, so without the search's own encoding it read mojibake and reported
// "(matched outside any symbol)" for a file full of them.
// ---------------------------------------------------------------------------

describe('GrepTool — symbols mode respects encoding', () => {
  let encDir: string
  let widePath: string

  const SOURCE = `export function wideHelper(id: string) {
  return 'ZQENCODED' + id
}

export class WideFactory {
  buildWidget() {
    return 'ZQENCODED'
  }
}
`

  beforeAll(() => {
    encDir = mkdtempSync(join(tmpdir(), 'grep-encoding-'))
    widePath = join(encDir, 'wide.ts')
    // UTF-16LE with no BOM: ripgrep needs --encoding to match it at all, and
    // the symbol scan needs the same label to parse it.
    writeFileSync(widePath, Buffer.from(SOURCE, 'utf16le'))
    // A UTF-8 sibling holding the same symbols, to prove the assertions below
    // are about the decode and not about the parser.
    writeFileSync(join(encDir, 'plain.ts'), SOURCE)
  })

  afterAll(() => {
    rmSync(encDir, { recursive: true, force: true })
  })

  async function encGrep(input: Record<string, unknown>): Promise<GrepData> {
    const { data } = await GrepTool.call(
      { path: encDir, ...input } as never,
      makeContext(),
    )
    return data as GrepData
  }

  test('the UTF-8 sibling maps to symbols (control)', async () => {
    const data = await encGrep({
      pattern: 'ZQENCODED',
      output_mode: 'symbols',
      glob: 'plain.ts',
    })

    expect(data.numMatches).toBe(2)
    expect(data.content).toContain('wideHelper')
    expect(data.content).toContain('buildWidget')
  })

  test('the UTF-16 file maps to the same symbols when encoding is given', async () => {
    const data = await encGrep({
      pattern: 'ZQENCODED',
      output_mode: 'symbols',
      glob: 'wide.ts',
      encoding: 'utf-16le',
    })

    expect(data.numFiles).toBe(1)
    expect(data.numMatches).toBe(2)
    expect(data.content).toContain('wideHelper')
    expect(data.content).toContain('buildWidget')
    // The exact string the bug produced.
    expect(data.content).not.toContain('matched outside any symbol')
  })

  test('content mode returns decoded lines, which is what feeds the pivot', async () => {
    const data = await encGrep({
      pattern: 'ZQENCODED',
      output_mode: 'content',
      glob: 'wide.ts',
      encoding: 'utf-16le',
    })

    expect(data.content).toContain('ZQENCODED')
    expect(data.content).not.toContain('\u0000')
  })

  test('without the label the file is not even matched', async () => {
    const data = await encGrep({
      pattern: 'ZQENCODED',
      output_mode: 'symbols',
      glob: 'wide.ts',
    })

    expect(data.numFiles).toBe(0)
  })

  test('an unknown label is refused before any scanning', async () => {
    await expect(
      encGrep({
        pattern: 'ZQENCODED',
        output_mode: 'symbols',
        glob: 'wide.ts',
        encoding: 'utf16',
      }),
    ).rejects.toThrow(/unknown encoding/)
  })
})

// ---------------------------------------------------------------------------
// The auto-pivot builds the same symbol map from content-mode lines, so it is
// a second call site that has to carry the label. A corpus wide enough to trip
// the pivot is the only way to reach it — asserting on content mode instead
// leaves that call site uncovered.
// ---------------------------------------------------------------------------

describe('GrepTool — auto-pivot respects encoding', () => {
  let pivotDir: string
  let previousForce: string | undefined

  beforeAll(() => {
    pivotDir = mkdtempSync(join(tmpdir(), 'grep-pivot-enc-'))
    // 6 files clears GREP_PIVOT_MIN_FILES (5); 12 matches each clears
    // GREP_PIVOT_THRESHOLD_MATCH_LINES (60) at 72.
    for (let f = 0; f < 6; f++) {
      const body = Array.from(
        { length: 12 },
        (_, i) => `  const v${i} = 'ZQPIVOT' + ${i}`,
      ).join('\n')
      const src = `export function pivotFn${f}() {\n${body}\n}\n`
      writeFileSync(join(pivotDir, `mod${f}.ts`), Buffer.from(src, 'utf16le'))
    }
    previousForce = process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
    process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = '1'
  })

  afterAll(() => {
    if (previousForce === undefined) {
      delete process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT
    } else {
      process.env.CLAUDIN_FORCE_GREP_AUTO_PIVOT = previousForce
    }
    rmSync(pivotDir, { recursive: true, force: true })
  })

  test('a content search over UTF-16 files pivots to a decoded symbol map', async () => {
    const { data } = await GrepTool.call(
      {
        pattern: 'ZQPIVOT',
        path: pivotDir,
        output_mode: 'content',
        encoding: 'utf-16le',
      } as never,
      makeContext(),
    )
    const d = data as GrepData

    // Confirm the pivot actually fired — without it the assertions below would
    // be about content mode and the pivot call site would stay untested.
    expect(d.autoPivot).toBe(true)
    expect(d.mode).toBe('symbols')
    expect(d.numFiles).toBe(6)
    expect(d.content).toContain('pivotFn0')
    expect(d.content).not.toContain('matched outside any symbol')
  })
})
