/**
 * The fix decisions of the teamMemSafety rewrite (spec findings 1 to 6), each
 * pinned where the characterization suites keep the old behaviour out of view.
 *
 * Credential-shaped values are glued from pieces at run time, as in the
 * scanner suite, so no token-shaped literal is committed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Dirent, Stats } from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'
import { formatMemoryManifest, scanMemoryFiles, type MemoryHeader } from 'src/memory/memdir/memoryScan.js'
import { normalizeDescription } from 'src/memory/memdir/memoryScan/readMemoryHeader.js'
import { walkMemoryDir, type WalkMemoryDirDeps } from 'src/memory/memdir/memoryScan/walkMemoryDir.js'
import { scanForSecrets } from 'src/memory/memdir/secretScanner.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { isTeamMemorySearch } from 'src/memory/memdir/teamMemoryOps.js'

const world = useMemdirWorld()

const cycle = (alphabet: string, n: number): string =>
  Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('')
const glue = (...parts: string[]): string => parts.join('')
const flagged = (text: string): string[] => scanForSecrets(text).map(m => m.ruleId)

const HEX = '0f1e2d3c4b5a6978'
const ALNUM = 'q7Wr2Ty9Up4As6Df8Gh3Jk5Lz1Xc0Vb'
const B64 = 'Qw7+Er2/Ty9Up4As6Df8Gh3Jk5Lz1Xc0'
const dash5 = '-'.repeat(5)

describe('finding 1: the private-key check is linear', () => {
  const marker = glue(dash5, 'BEGIN RSA PRIVATE KEY', dash5, '\n')
  const flood = marker.repeat(Math.ceil((432 * 1024) / marker.length))

  test('432 KB of BEGIN markers with no END is scanned well under a second', () => {
    // The quadratic matcher took about 27 s on this input.
    const started = performance.now()
    expect(scanForSecrets(flood)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('the same flood closed by an END marker is a key', () => {
    expect(flagged(glue(flood, dash5, 'END RSA PRIVATE KEY', dash5))).toEqual(['private-key'])
  })

  const pem = (inner: string): string =>
    glue(dash5, 'BEGIN EC PRIVATE KEY', dash5, inner, dash5, 'END EC PRIVATE KEY', dash5)
  test.each([
    ['64 characters between the markers', pem(cycle(B64, 64)), ['private-key']],
    ['63 characters between the markers', pem(cycle(B64, 63)), []],
    ['an END marker before the BEGIN', glue(dash5, 'END EC PRIVATE KEY', dash5, cycle(B64, 90), dash5, 'BEGIN EC PRIVATE KEY', dash5), []],
    ['a short key, then a later END far enough from the first BEGIN', glue(pem(cycle(B64, 10)), cycle(B64, 80), dash5, 'END PRIVATE KEY', dash5), ['private-key']],
  ] as const)('%s', (_what, text, expected) => {
    expect(flagged(text)).toEqual([...expected])
  })
})

describe('finding 2: punctuation after a token ends it', () => {
  const families: Array<[string, string]> = [
    ['npm-access-token', glue('np', 'm_', cycle(ALNUM, 36))],
    ['gcp-api-key', glue('AI', 'za', cycle('q7W_r2T-y9U', 35))],
    ['digitalocean-pat', glue('dop', '_v1_', cycle(HEX, 64))],
    ['databricks-api-token', glue('da', 'pi', cycle(HEX, 32))],
    ['stripe-access-token', glue('sk', '_live_', cycle(ALNUM, 24))],
    ['sendgrid-api-token', glue('S', 'G.', cycle(ALNUM, 22), '.', cycle(ALNUM, 43))],
    ['grafana-cloud-api-token', glue('gl', 'c_', cycle(B64, 48), '=')],
    ['sentry-user-token', glue('snt', 'ryu_', cycle(HEX, 64))],
  ]
  for (const [ruleId, token] of families) {
    test(`${ruleId} is flagged before . , ) ] >`, () => {
      for (const after of ['.', ',', ')', ']', '>']) {
        expect({ after, flagged: flagged(`See [the key](${token}${after} now`) }).toEqual({ after, flagged: [ruleId] })
      }
    })
  }

  test('a run that continues the token is still let through', () => {
    for (const [what, text] of [
      ['npm, one letter longer', glue('np', 'm_', cycle(ALNUM, 36), 'x')],
      ['npm, then a dash', glue('np', 'm_', cycle(ALNUM, 36), '-x')],
      ['grafana cloud, then base64 past its longest', glue('gl', 'c_', cycle(B64, 401))],
      ['sendgrid, then an equals sign', glue('S', 'G.', cycle(ALNUM, 66), '=')],
      ['npm, glued to a word', glue('x', 'np', 'm_', cycle(ALNUM, 36), '.')],
    ]) {
      expect({ what, flagged: flagged(text!) }).toEqual({ what, flagged: [] })
    }
  })
})

describe('finding 3: a symlink cycle neither empties nor repeats the listing', () => {
  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'teammem-fixes-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const names = async (): Promise<string[]> =>
    (await scanMemoryFiles(root, new AbortController().signal)).map(h => h.filename).sort()

  test('a link back to the root', async () => {
    writeFileSync(join(root, 'a.md'), '# a\n')
    symlinkSync(root, join(root, 'loop'))
    expect(await names()).toEqual(['a.md'])
  })

  test('two links into a cycle below the root', async () => {
    mkdirSync(join(root, 'x'))
    mkdirSync(join(root, 'y'))
    writeFileSync(join(root, 'x', 'a.md'), '# a\n')
    writeFileSync(join(root, 'y', 'b.md'), '# b\n')
    symlinkSync(join(root, 'y'), join(root, 'x', 'to-y'))
    symlinkSync(join(root, 'x'), join(root, 'y', 'to-x'))
    expect(await names()).toEqual([join('x', 'a.md'), join('y', 'b.md')])
  })

  test('a second name for a directory lists its files once, under the real name', async () => {
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'a.md'), '# a\n')
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    expect(await names()).toEqual([join('real', 'a.md')])
  })

  // Root reads every file whatever its mode, so the case cannot be built there.
  test.skipIf(process.getuid?.() === 0)('a file that cannot be read is skipped, and the rest still listed', async () => {
    writeFileSync(join(root, 'ok.md'), '# ok\n')
    writeFileSync(join(root, 'locked.md'), '# locked\n')
    chmodSync(join(root, 'locked.md'), 0o000)
    expect(await names()).toEqual(['ok.md'])
  })

  test('a broken link and an unreadable directory are skipped, not fatal', async () => {
    const dirent = (name: string, kind: 'dir' | 'file' | 'link'): Dirent =>
      ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' }) as Dirent
    let ino = 0
    const dirStats = (): Stats => ({ dev: 1, ino: ++ino, isDirectory: () => true, isFile: () => false }) as Stats
    const deps: WalkMemoryDirDeps = {
      readdir: async dir => {
        if (dir === '/m') return [dirent('ok.md', 'file'), dirent('locked', 'dir'), dirent('dangling', 'link')]
        throw new Error(`EACCES: ${dir}`)
      },
      stat: async path => {
        if (path.endsWith('dangling')) throw new Error('ENOENT')
        return dirStats()
      },
    }
    expect(await walkMemoryDir('/m', new AbortController().signal, deps)).toEqual(['ok.md'])
  })
})

describe('finding 4: a search of the team directory itself is a team search', () => {
  test.each([
    ['with its trailing separator', () => getTeamMemPath()],
    ['without it', () => getTeamMemPath().slice(0, -sep.length)],
  ])('%s', (_what, path) => {
    expect(isTeamMemorySearch({ pattern: 'x', path: path() })).toBe(true)
  })

  test('not while auto memory is off', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    world().refresh()
    expect(isTeamMemorySearch({ pattern: 'x', path: getTeamMemPath() })).toBe(false)
  })
})

describe('findings 5 and 6: the description is one line of text, or null', () => {
  test.each([
    ['a string', 'deploy steps', 'deploy steps'],
    ['a number', 42, '42'],
    ['a boolean', true, 'true'],
    ['a list', ['x', 'y'], null],
    ['a mapping', { a: 1 }, null],
    ['null', null, null],
    ['blank text', '  \n ', null],
    ['text over several lines', 'first line\nsecond\tline\n', 'first line second line'],
  ] as const)('%s', (_what, raw, expected) => {
    expect(normalizeDescription(raw)).toBe(expected)
  })

  let root = ''
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'teammem-desc-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('scanned from real frontmatter, they render as one manifest line each', async () => {
    writeFileSync(join(root, 'block.md'), ['---', 'description: |', '  line one', '  line two', '---', 'body'].join('\n'))
    writeFileSync(join(root, 'number.md'), ['---', 'description: 42', '---', 'body'].join('\n'))
    writeFileSync(join(root, 'list.md'), ['---', 'description: [x, y]', '---', 'body'].join('\n'))
    const byName = Object.fromEntries(
      (await scanMemoryFiles(root, new AbortController().signal)).map(h => [h.filename, h.description]),
    )
    expect(byName).toEqual({ 'block.md': 'line one line two', 'number.md': '42', 'list.md': null })
  })

  test('the manifest keeps a header built elsewhere on one line too', () => {
    const header: MemoryHeader = {
      filename: 'n.md',
      filePath: join(root, 'n.md'),
      mtimeMs: Date.UTC(2026, 0, 1),
      description: 'a\nb',
      type: undefined,
    }
    expect(formatMemoryManifest([header])).toBe('- n.md (2026-01-01T00:00:00.000Z): a b')
  })
})
