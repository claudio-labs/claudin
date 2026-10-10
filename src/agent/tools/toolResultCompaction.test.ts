import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { maybeCompactToolResult } from 'src/agent/tools/toolResultSummarizer.js'
import { compactGlobOutput } from 'src/agent/tools/toolResultSummarizer/glob.js'
import { compactGrepOutput } from 'src/agent/tools/toolResultSummarizer/grep.js'
import { isAlreadyCompacted } from 'src/agent/tools/toolResultSummarizer/markers.js'
import { processPreMappedToolResultBlock } from 'src/agent/tools/toolResultStorage.js'

// Tool results are compacted, never cut: a Grep or Glob result is regrouped
// without losing a line, and one past its tool's persistence line is paged.
// Every regroup is pinned by decoding what it printed back into what it was
// given, in order, byte for byte.

const savedKillSwitch = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER

beforeAll(() => {
  saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: true }))
})
beforeEach(() => {
  delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
})
afterAll(() => {
  resetGlobalConfigForTests()
  if (savedKillSwitch === undefined) delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
  else process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = savedKillSwitch
})

// A distinct id per block: persistence never rewrites a file it already saved
// under an id (real ids are unique), so a shared one would read another test's.
let nextId = 0
const block = (content: ToolResultBlockParam['content']): ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: `toolu_lossless_${nextId++}`,
  content,
})

/** The body inside an envelope, without its two tag lines. */
function bodyOf(content: unknown): string {
  const lines = String(content).split('\n')
  return lines.slice(1, -1).join('\n')
}

// ---------------------------------------------------------------------------
// Fixtures and their decoders
// ---------------------------------------------------------------------------

/**
 * ripgrep content output: `files` files of `matches` hits with `context` lines
 * on each side, a blank context line in each block, `--` between blocks, in
 * an order that is neither alphabetical nor by match count.
 */
function grepOutput(files: number, matches: number, context: number): string {
  const lines: string[] = []
  for (let f = files - 1; f >= 0; f--) {
    const path = `src/agent/module${f}/implementation${f}.ts`
    for (let m = 0; m < matches + (f % 3); m++) {
      if (lines.length > 0) lines.push('--')
      const at = 10 + m * (2 * context + 5)
      for (let k = context; k > 0; k--) lines.push(`${path}-${at - k}-${k === 2 ? '' : `  const before${f}_${m}_${k} = ${k}`}`)
      lines.push(`${path}:${at}:export const hit${f}_${m} = '${'x'.repeat(40)}'`)
      for (let k = 1; k <= context; k++) lines.push(`${path}-${at + k}-  const after${f}_${m}_${k} = ${k}`)
    }
  }
  return lines.join('\n')
}

/** Every line rg printed, back from `compactGrepOutput`, in order. */
function decodeGrep(body: string): string[] {
  const out: string[] = []
  let file: string | null = null
  for (const line of body.split('\n')) {
    const header = /^--- (.*) ---$/.exec(line)
    if (header) {
      file = header[1]!
      continue
    }
    if (line === '--') {
      out.push(line)
      continue
    }
    const entry = file === null ? null : /^(\d+)([:-])(.*)$/s.exec(line)
    if (entry) {
      out.push(`${file}${entry[2]}${entry[1]}${entry[2]}${entry[3]}`)
      continue
    }
    file = null
    out.push(line)
  }
  return out
}

function globOutput(dirs: number, perDir: number): string {
  const lines: string[] = []
  for (let d = 0; d < dirs; d++) {
    for (let i = 0; i < perDir; i++) lines.push(`src/tools/shared/outputFilter/group${d}/file${i}.ts`)
    lines.push(`README${d}.md`)
  }
  return lines.join('\n')
}

function decodeGlob(body: string): string[] {
  const out: string[] = []
  const lines = body.split('\n')
  let dir = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('  ')) out.push(dir + line.slice(2))
    // A header is a `dir/` line with an indented path after it.
    else if (line.endsWith('/') && lines[i + 1]?.startsWith('  ')) dir = line
    else out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// compactGrepOutput
// ---------------------------------------------------------------------------

describe('compactGrepOutput', () => {
  const roundTrips = (raw: string) => {
    const result = compactGrepOutput(raw)!
    expect(result.strategy).toBe('compact-grep')
    expect(decodeGrep(result.body)).toEqual(raw.split('\n'))
    return result
  }

  test('keeps every line in rg order — blocks, blank context, separators, long lines', () => {
    const raw = `${grepOutput(60, 14, 6)}\nsrc/agent/long.ts:1:${'y'.repeat(900)}`
    const result = roundTrips(raw)
    expect(result.body.length).toBeLessThan(raw.length)
    // rg's order, not match count: the first file stays first.
    expect(result.body.split('\n')[0]).toBe('--- src/agent/module59/implementation59.ts ---')
  })

  test('the notes GrepTool adds stay where they were', () => {
    const raw = `Note: 2 binary files were skipped\n${grepOutput(4, 6, 2)}\n\n[Showing results with pagination = limit: 250]`
    roundTrips(raw)
    // A line naming no file ends the run, so the same file's next line opens a header again.
    roundTrips(['src/agent/a.ts:1:alpha', '', 'src/agent/a.ts:2:beta', 'src/agent/a.ts:3:gamma'].join('\n'))
  })

  test('a path the parser misreads still comes back byte for byte', () => {
    const raw = [
      'docs/phase-0-plumbing.md:31:alpha',
      'docs/phase-1-skeleton.md:88:beta',
      'src/x.ts:5:gamma',
      '12-notes.md:3:hello',
      '12-notes.md:4:world',
    ].join('\n')
    const result = roundTrips(raw)
    // Read as file `docs/phase`, lines 0 and 1 — context with no match of its
    // own, so it earns no header and its lines ship as rg printed them.
    expect(result.body).not.toContain('--- docs/phase ---')
    expect(result.body.split('\n').slice(0, 3)).toEqual(raw.split('\n').slice(0, 3))
  })

  test('a count listing whose paths carry -N- gets no header for a file that does not exist', () => {
    const raw = [
      '.claudin/memory/team/bugs/codex-403-html-block-misclassified-as-login.md:1',
      '.claudin/memory/team/weekly-token-census-2026-09-08.md:3',
      '.claudin/memory/team/weekly-token-census-2026-09-20.md:2',
    ].join('\n')
    expect(compactGrepOutput(raw)).toBeNull()
  })

  test('a run its header would not pay for keeps the path inline: no run ever grows', () => {
    const dense = Array.from({ length: 14 }, (_, i) => `src/agent/tools/dense.ts:${i + 1}:hit ${i}`)
    const singles = Array.from({ length: 35 }, (_, i) => `src/s${i}.ts:${i + 1}:one`)
    const raw = [...dense, ...singles].join('\n')
    const result = roundTrips(raw)
    expect(result.body.split('\n').filter(l => l.startsWith('--- '))).toEqual(['--- src/agent/tools/dense.ts ---'])
    expect(result.body.endsWith(singles.join('\n'))).toBe(true)
  })

  test('null when an inline path starts with a number after a header: it would read as a numbered line', () => {
    const raw = ['src/agent/tools/a.ts:1:x', 'src/agent/tools/a.ts:2:y', '9-x.md:3:z'].join('\n')
    expect(compactGrepOutput(raw)).toBeNull()
  })

  test('without line numbers (-n false) the order and the blocks survive', () => {
    const raw = ['app.log:10:00:01 start', 'app.log:09:59:59 prev', '--', 'app.log:08:00:00 boot'].join('\n')
    roundTrips(raw)
  })

  test('a body that looks like a reference or a header is kept as it is', () => {
    const raw = ['src/a.ts:1:const x = 1', 'src/a.ts:2:… same as src/a.ts:1', 'src/a.ts:3:--- not a header ---'].join('\n')
    roundTrips(raw)
  })

  test('null when a line it would leave alone reads as a header or a numbered line', () => {
    // Between two runs that pay for their headers, so the regroup would otherwise ship.
    const around = (middle: string) =>
      ['src/agent/tools/a.ts:1:x', 'src/agent/tools/a.ts:2:y', middle, 'src/agent/tools/b.ts:1:x', 'src/agent/tools/b.ts:2:y'].join('\n')
    expect(compactGrepOutput(around('a note between them'))).not.toBeNull()
    expect(compactGrepOutput(around('--- note ---'))).toBeNull()
    expect(compactGrepOutput(around('3:12 PM'))).toBeNull()
  })

  test('null with nothing to group: no filenames, a count, a file list', () => {
    expect(compactGrepOutput(['10:alpha', '11-beta', '12:gamma'].join('\n'))).toBeNull()
    expect(compactGrepOutput(['src/a.ts:12', 'src/b.ts:3'].join('\n'))).toBeNull()
    expect(compactGrepOutput(['src/a.ts', 'src/b.ts'].join('\n'))).toBeNull()
  })
})

describe('compactGrepOutput — real rg output and odd line shapes', () => {
  const FIXTURES = join(import.meta.dir, '__fixtures__', 'grepSamples')
  /** Decodes back exactly when it regroups; ships nothing when it does not. */
  const holds = (raw: string) => {
    const result = compactGrepOutput(raw)
    if (result !== null) expect(decodeGrep(result.body)).toEqual(raw.split('\n'))
    return result
  }

  test.each(readdirSync(FIXTURES).filter(f => f.endsWith('.txt')))('%s comes back byte for byte', name => {
    holds(readFileSync(join(FIXTURES, name), 'utf8'))
  })

  test('the recorded multi-file and context samples do regroup', () => {
    for (const name of ['multi-file', 'context-12', 'context-30', 'unscoped-wide']) {
      expect(holds(readFileSync(join(FIXTURES, `${name}.txt`), 'utf8'))).not.toBeNull()
    }
  })

  const pad = ' '.repeat(50)
  test.each([
    ['a Windows drive letter', [String.raw`C:\proj\src\a.ts:10:const x = 1${pad}`, String.raw`C:\proj\src\a.ts-11-const y = 2${pad}`, String.raw`C:\proj\src\a.ts:12:const z = 3${pad}`]],
    ['a path that contains :N:', [`src/a:1:b.ts:10:one${pad}`, `src/a:1:b.ts:11:two${pad}`, `src/a:1:b.ts:12:three${pad}`]],
    ['a match whose text is --', ['src/a.ts:10:--', '--', 'src/a.ts:11:real', 'src/a.ts:12:more']],
    ['empty match bodies', ['src/agent/a.ts:1:', 'src/agent/a.ts:2:', 'src/agent/a.ts:3:', 'src/agent/a.ts:4:']],
    ['carriage returns and control bytes', [`src/agent/a.ts:1:one\r`, `src/agent/a.ts:2:two\u0007${pad}`, `src/agent/a.ts:3:\tthree${pad}`]],
    ['line numbers as rg wrote them', [`src/agent/a.ts:007:x${pad}`, `src/agent/a.ts:08:y${pad}`, `src/agent/a.ts:9:z${pad}`]],
    ['a filename that mimics a header', [`src/--- fake (9 matches) ---.ts:10:one${pad}`, `src/--- fake (9 matches) ---.ts:11:two${pad}`, `src/--- fake (9 matches) ---.ts:12:three${pad}`]],
  ])('%s comes back byte for byte', (_, lines) => {
    holds(lines.join('\n'))
  })
})

// ---------------------------------------------------------------------------
// compactGlobOutput
// ---------------------------------------------------------------------------

describe('compactGlobOutput', () => {
  test('groups adjacent paths under their directory and decodes back in order', () => {
    const raw = `${globOutput(4, 30)}\n(Results are truncated. Consider using a more specific path or pattern.)`
    const result = compactGlobOutput(raw)!
    expect(result.strategy).toBe('compact-glob')
    expect(result.envelopeAttrs).toEqual({ paths: String(4 * 31) })
    expect(result.body.length).toBeLessThan(raw.length)
    expect(decodeGlob(result.body)).toEqual(raw.split('\n'))
  })

  test('a directory listing is left as it is', () => {
    const raw = ['src/tools/shared/outputFilter/', ...Array.from({ length: 12 }, (_, i) => `src/tools/shared/outputFilter/dir${i}/`)].join('\n')
    // A path ending in `/` is never grouped: it would read as a header.
    expect(compactGlobOutput(raw)).toBeNull()
  })

  test('paths of one directory that are not adjacent are not reordered', () => {
    expect(compactGlobOutput(['src/a/x.ts', 'src/b/y.ts', 'src/a/z.ts'].join('\n'))).toBeNull()
  })

  test('null when a path starts with a space: it would read as listed under a group', () => {
    const raw = [...Array.from({ length: 10 }, (_, i) => `src/tools/shared/file${i}.ts`), '  odd name.ts'].join('\n')
    expect(compactGlobOutput(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// maybeCompactToolResult
// ---------------------------------------------------------------------------

describe('maybeCompactToolResult', () => {
  test('a Grep result past the floor comes back regrouped, in an envelope that claims no cut', () => {
    const raw = grepOutput(2, 14, 3)
    const content = String(maybeCompactToolResult(block(raw), GREP_TOOL_NAME).content)
    expect(content).toStartWith('<tool-result-compacted tool="Grep" strategy="compact-grep">\n')
    expect(content).not.toContain('kept=')
    expect(decodeGrep(bodyOf(content))).toEqual(raw.split('\n'))
    expect(isAlreadyCompacted(content)).toBe(true)
  })

  test('every other tool comes back untouched — nothing of theirs is reformatted', () => {
    const json = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) }, null, 2)
    const repeated = Array<string>(400).fill('warning: unused import `std::fmt`').join('\n')
    for (const [tool, text] of [
      [BASH_TOOL_NAME, repeated],
      [BASH_TOOL_NAME, json],
      [WEB_FETCH_TOOL_NAME, repeated],
      ['mcp__github__list_issues', json],
    ] as const) {
      const b = block(text)
      expect(maybeCompactToolResult(b, tool)).toBe(b)
    }
    const report = block([{ type: 'text', text: repeated }])
    expect(maybeCompactToolResult(report, AGENT_TOOL_NAME)).toBe(report)
  })

  test('a compacted result is never touched again', () => {
    const once = maybeCompactToolResult(block(grepOutput(2, 14, 3)), GREP_TOOL_NAME)
    expect(maybeCompactToolResult(once, GREP_TOOL_NAME)).toBe(once)
  })

  test('a small result ships as it came, even one the regroup would shrink', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `src/agent/tools/small.ts:${i + 1}:hit ${i}`).join('\n')
    expect(raw.length).toBeLessThan(3_000)
    expect(compactGrepOutput(raw)).not.toBeNull()
    const b = block(raw)
    expect(maybeCompactToolResult(b, GREP_TOOL_NAME)).toBe(b)
  })

  test('the summarizer kill switch stops the regroup too', () => {
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = '1'
    const b = block(grepOutput(2, 14, 3))
    expect(maybeCompactToolResult(b, GREP_TOOL_NAME)).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// The storage layer: compacted under the line, paged past it, never cut
// ---------------------------------------------------------------------------

describe('processPreMappedToolResultBlock — compact, then page past the line', () => {
  const grep = { name: GREP_TOOL_NAME, maxResultSizeChars: 20_000 }
  // A result past its line is saved: keep it out of the real config dir.
  const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const testConfigDir = join(tmpdir(), `claudin-lossless-spill-${process.pid}-${Date.now()}`)
  beforeAll(() => {
    process.env.CLAUDIN_CONFIG_DIR = testConfigDir
    mkdirSync(testConfigDir, { recursive: true })
  })
  afterAll(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
    rmSync(testConfigDir, { recursive: true, force: true })
  })

  test('a Grep result that regroups under 20k ships whole', async () => {
    const raw = grepOutput(2, 14, 3)
    const out = await processPreMappedToolResultBlock(block(raw), grep)
    expect(decodeGrep(bodyOf(out.content))).toEqual(raw.split('\n'))
  })

  test('a regrouped Grep ships at exactly the line, and one char past it is paged', async () => {
    const raw = grepOutput(2, 14, 3)
    const size = String(maybeCompactToolResult(block(raw), GREP_TOOL_NAME).content).length
    const at = await processPreMappedToolResultBlock(block(raw), { name: GREP_TOOL_NAME, maxResultSizeChars: size })
    expect(String(at.content)).toStartWith('<tool-result-compacted')
    const past = await processPreMappedToolResultBlock(block(raw), { name: GREP_TOOL_NAME, maxResultSizeChars: size - 1 })
    expect(String(past.content)).toStartWith('<persisted-output>')
  })

  test('one too big even regrouped is paged, never summarized: the file holds it whole', async () => {
    const raw = grepOutput(4, 80, 1)
    expect(compactGrepOutput(raw)!.body.length).toBeGreaterThan(20_000)
    const out = String((await processPreMappedToolResultBlock(block(raw), grep)).content)
    expect(out.length).toBeLessThanOrEqual(20_000)
    expect(out).toStartWith('<persisted-output>')
    expect(out).toMatch(/^Lines 1-\d+ are below; Read the file from line \d+ for the rest\.$/m)
    const saved = readFileSync(/Full output saved to: (\S+)\n/.exec(out)![1]!, 'utf8')
    expect(decodeGrep(bodyOf(saved))).toEqual(raw.split('\n'))
  })

  test('an agent report under its line ships untouched, blocks and all', async () => {
    const report = Array.from({ length: 300 }, (_, i) => `Finding ${i}: ${'v'.repeat(40)}`).join('\n')
    const b = block([{ type: 'text', text: report }])
    const out = await processPreMappedToolResultBlock(b, { name: AGENT_TOOL_NAME, maxResultSizeChars: 100_000 })
    expect(out.content).toEqual([{ type: 'text', text: report }])
  })

  test('a Glob listing under its line keeps every path', async () => {
    const raw = globOutput(5, 40)
    const out = await processPreMappedToolResultBlock(block(raw), { name: GLOB_TOOL_NAME, maxResultSizeChars: 100_000 })
    expect(String(out.content)).toStartWith('<tool-result-compacted tool="Glob"')
    expect(decodeGlob(bodyOf(out.content))).toEqual(raw.split('\n'))
  })
})
