import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  detectOutlineLangFromPath,
  scanSymbols,
} from 'src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutline } from 'src/tools/shared/codeOutline/renderOutline.js'
import { findSites } from './findSites.js'
import { renderPreview } from './renderPreview.js'

const SOURCE = [
  'export function loadAll() {',
  '  const c = cfg(1)',
  '  return cfg(c)',
  '}',
  '',
  'export function resetAll() {',
  '  // cfg is mentioned here only',
  '  return cfg()',
  '}',
  '',
]

describe('renderPreview', () => {
  let dir: string
  let filePath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rename-preview-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    filePath = join(dir, 'src', 'a.ts')
    writeFileSync(filePath, SOURCE.join('\n'))
    writeFileSync(join(dir, 'README.md'), 'see cfg for details\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function preview(): Promise<string> {
    const res = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })
    return renderPreview(res, { symbol: 'cfg', replacement: 'config' })
  }

  test('groups sites under their enclosing symbol with a site count', async () => {
    const out = await preview()

    expect(out).toContain('src/a.ts')
    expect(out).toContain('export function loadAll()    2 sites')
    expect(out).toContain('export function resetAll()    1 site')
    expect(out).toMatch(/s0\d {2}:2 {2}const c = cfg\(1\)/)
  })

  test('marks a file with no string/comment analysis', async () => {
    const out = await preview()

    expect(out).toContain('README.md  ~')
    expect(out).toContain('`~` marks a file with no string/comment analysis')
  })

  test('reports masked-out occurrences and the token', async () => {
    const out = await preview()

    // The `// cfg is mentioned here only` comment is not a site.
    expect(out).toContain('Skipped 1 occurrence(s) inside strings or comments.')
    expect(out).toMatch(/sitesToken: [0-9a-f]{12}/)
  })

  // The preview is only useful as an outline if its coordinates ARE the
  // outline's — a drift here would send Read(symbol=…) to the wrong body.
  // Asserted against the scanner's own numbers, not against renderOutline's
  // string: both renderers share `rangeLabel`, so comparing formatted text to
  // formatted text would still pass if that shared formatter drifted.
  test('symbol ranges are the scanner line numbers, not a re-derived label', async () => {
    const out = await preview()
    const source = SOURCE.join('\n')
    const entries = scanSymbols(source, detectOutlineLangFromPath(filePath)!)

    const rangeRows = out
      .split('\n')
      .map(l => /^ {2}(\d+)-(\d+) {2}(.+?) {4}\d+ sites?$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)

    expect(rangeRows.length).toBe(2)
    for (const [, start, end, signature] of rangeRows) {
      const entry = entries.find(e => e.signature === signature)
      expect(entry).toBeDefined()
      expect(Number(start)).toBe(entry!.startLine)
      expect(Number(end)).toBe(entry!.endLine)
    }
  })

  test('the rendered preview keeps its shape', async () => {
    expect((await preview()).replace(/[0-9a-f]{12}/, '<token>')).toMatchSnapshot()
  })

  test('a preview row is reachable from the outline of the same file', async () => {
    const out = await preview()
    const source = SOURCE.join('\n')
    const lang = detectOutlineLangFromPath(filePath)!
    const outline = renderOutline(
      scanSymbols(source, lang),
      filePath,
      source.split('\n').length,
    )

    const rangeRows = out
      .split('\n')
      .map(l => /^ {2}(\d+-\d+) {2}(.+?) {4}\d+ sites?$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)

    expect(rangeRows.length).toBe(2)
    for (const [, range, signature] of rangeRows) {
      expect(outline).toContain(`${range}  ${signature}`)
    }
  })

  test('says so plainly when nothing matches', async () => {
    const res = await findSites({
      symbol: 'nothingHere',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })
    const out = renderPreview(res, {
      symbol: 'nothingHere',
      replacement: 'x',
    })

    expect(out).toContain('no code site for "nothingHere"')
  })
})
