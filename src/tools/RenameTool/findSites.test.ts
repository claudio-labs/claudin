import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  findSites,
  isValidIdentifier,
  scanFileForSites,
} from 'src/tools/RenameTool/findSites.js'

describe('isValidIdentifier', () => {
  test('accepts identifiers, rejects anything regex-ish or pathy', () => {
    expect(isValidIdentifier('getUserConfig')).toBe(true)
    expect(isValidIdentifier('_private')).toBe(true)
    expect(isValidIdentifier('$store')).toBe(true)
    expect(isValidIdentifier('A1')).toBe(true)

    expect(isValidIdentifier('')).toBe(false)
    expect(isValidIdentifier('1abc')).toBe(false)
    expect(isValidIdentifier('get user')).toBe(false)
    expect(isValidIdentifier('get.*')).toBe(false)
    expect(isValidIdentifier('src/a.ts')).toBe(false)
    expect(isValidIdentifier('a-b')).toBe(false)
  })
})

describe('scanFileForSites — word boundary', () => {
  test('does not match inside a longer identifier', () => {
    const src = 'cfg\ncfgX\nXcfg\nmy_cfg\ncfg_2\n'
    const { offsets } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets).toEqual([0])
  })

  test('$ continues an identifier in TS, so $cfg is a different name', () => {
    const src = 'const $cfg = 1\nconst cfg = 2\n'
    const { offsets } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(1)
    expect(src.slice(offsets[0]! - 6, offsets[0]!)).toBe('const ')
  })

  test('$ is a sigil in bash and php, so $cfg IS a reference to cfg', () => {
    expect(scanFileForSites('cfg=1\necho $cfg\n', 'cfg', 'bash').offsets.length).toBe(2)
    // A double-quoted expansion is interpolated code, not string text — the
    // whole point of renaming a shell variable.
    expect(
      scanFileForSites('cfg=1\necho "$cfg ${cfg}"\n', 'cfg', 'bash').offsets
        .length,
    ).toBe(3)
    // Single quotes do not expand, so that one stays text.
    expect(
      scanFileForSites("cfg=1\necho '$cfg'\n", 'cfg', 'bash').offsets.length,
    ).toBe(1)

    const php = '<?php\n$cfg = 1;\necho $cfg;\n'
    expect(scanFileForSites(php, 'cfg', 'php').offsets.length).toBe(2)
    expect(
      scanFileForSites('<?php\n$a = "x $cfg {$cfg}";\n', 'cfg', 'php').offsets
        .length,
    ).toBe(2)
  })

  test('- continues an identifier in CSS only', () => {
    const css = '.a { --cfg-x: 1; color: var(--cfg); }\n'
    expect(scanFileForSites(css, 'cfg', 'css').offsets.length).toBe(0)
    expect(scanFileForSites('cfg-x\n', 'cfg', 'typescript').offsets.length).toBe(1)
  })

  // Kotlin and Scala allow `$` inside an identifier, so the boundary rule has
  // to tell `val $cfg` (one longer name) from `"$cfg"` (a sigil + reference).
  test('a sigil in a string is punctuation, in code it continues the name', () => {
    const kt = 'val $cfg = 1\nval s = "x $cfg ${cfg}"\nval c = cfg\n'
    expect(scanFileForSites(kt, 'cfg', 'kotlin').offsets.length).toBe(3)

    const scala = 'val $cfg = 1\nval s = s"x $cfg"\nval c = cfg\n'
    expect(scanFileForSites(scala, 'cfg', 'scala').offsets.length).toBe(2)
  })

  test('$ is a sigil in PowerShell, in code and in an expanding string', () => {
    const ps = '$cfg = 1\nWrite-Output "x $cfg $($cfg)"\n'
    expect(scanFileForSites(ps, 'cfg', 'powershell').offsets.length).toBe(3)
    // A literal string does not expand, so that one stays text.
    expect(
      scanFileForSites("$cfg = 1\nWrite-Output 'x $cfg'\n", 'cfg', 'powershell')
        .offsets.length,
    ).toBe(1)
  })

  test('dart: a raw string keeps its dollar literal', () => {
    const dart = 'final a = "x $cfg";\nfinal b = r"x $cfg";\nfinal c = cfg;\n'
    expect(scanFileForSites(dart, 'cfg', 'dart').offsets.length).toBe(2)
  })

  test('groovy: only a double-quoted GString interpolates', () => {
    const groovy = 'def a = "x $cfg"\ndef b = \'x $cfg\'\ndef c = cfg\n'
    expect(scanFileForSites(groovy, 'cfg', 'groovy').offsets.length).toBe(2)
  })

  test('two references separated only by a sigil are both found', () => {
    const kt = 'val s = "$cfg$cfg"\n'
    expect(scanFileForSites(kt, 'cfg', 'kotlin').offsets.length).toBe(2)
  })

  test('rust: a plain string next to a negation stays text', () => {
    const negation = 'fn f(){ if !(x) { let s = "{cfg}"; } }'
    const found = scanFileForSites(negation, 'cfg', 'rust')
    expect(found.offsets.length).toBe(0)
    expect(found.maskedOut).toBe(1)
  })
})

describe('scanFileForSites — css', () => {
  test('a custom property is one hyphenated name', () => {
    const css = '.a { --cfg-x: 1; color: var(--cfg); }\n'
    expect(scanFileForSites(css, 'cfg', 'css').offsets.length).toBe(0)
    expect(scanFileForSites('cfg-x\n', 'cfg', 'typescript').offsets.length).toBe(1)
  })
})

describe('scanFileForSites — mask', () => {
  test('drops occurrences in strings and comments, keeps code', () => {
    const src = [
      '// cfg in a line comment',
      '/* cfg in a block comment */',
      'const s = "cfg in a string"',
      'const cfg = 1',
      'export { cfg }',
    ].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(2)
    expect(maskedOut).toBe(3)
  })

  test('keeps identifiers inside python f-strings', () => {
    const src = [
      'def f(u):',
      '    return f"user {cfg(u)}"',
      '    # cfg',
      '    x = "{cfg}"',
      '',
    ].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'python')

    expect(offsets.length).toBe(1)
    expect(maskedOut).toBe(2)
  })

  test('python docstrings and comments are masked', () => {
    const src = ['def f():', '    """cfg"""', '    # cfg', '    return cfg', ''].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'python')

    expect(offsets.length).toBe(1)
    expect(maskedOut).toBe(2)
  })

  // A `${…}` body is an expression, not string text. Masking it skipped every
  // interpolated call site and left half-renamed files behind.
  test('keeps identifiers inside template substitutions', () => {
    const src = [
      'const a = `total: ${cfg(1)}`',
      'const b = `cfg is not a site here`',
      'const c = `${ "cfg" } ${ /* cfg */ cfg }`',
    ].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(2)
    expect(maskedOut).toBe(3)
  })

  test('handles a template nested inside a substitution', () => {
    const src = 'const a = `${ x.map(v => `${cfg(v)} in a `) }`\n'
    const { offsets } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(1)
  })

  // JSX text is code to the masker, so an apostrophe in prose used to open a
  // literal that ran to the next one anywhere later in the file — and every
  // real site inside that span was counted as maskedOut and DROPPED from the
  // rename. Not a cosmetic bug: these are sites the tool refused to touch.
  test('an apostrophe in JSX prose does not swallow the sites after it', () => {
    const src = [
      'function Panel() {',
      "  return <Text>Don't ask again</Text>",
      '}',
      'const a = cfg(1)',
      'const b = cfg(2)',
    ].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(2)
    expect(maskedOut).toBe(0)
  })

  // Same class, the other cause: a quote inside a regex inside `${…}`.
  test('a regex in a substitution does not swallow the sites after it', () => {
    const src = [
      "const q = `'${v.replace(/'/g, 'x')}'`",
      'const a = cfg(1)',
    ].join('\n')
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'typescript')

    expect(offsets.length).toBe(1)
    expect(maskedOut).toBe(0)
  })

  test('a Go backtick string has no substitutions to unmask', () => {
    const src = 'q := `select ${cfg} from t`\nfoo(cfg)\n'
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'go')

    expect(offsets.length).toBe(1)
    expect(maskedOut).toBe(1)
  })

  test('a language with no mask keeps every occurrence', () => {
    const src = '# cfg\nkey: cfg\n'
    const { offsets, maskedOut } = scanFileForSites(src, 'cfg', 'yaml')

    expect(offsets.length).toBe(2)
    expect(maskedOut).toBe(0)
  })

  test('an unknown language keeps every occurrence', () => {
    const { offsets } = scanFileForSites('cfg cfg\n', 'cfg', null)

    expect(offsets.length).toBe(2)
  })
})

describe('findSites', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rename-sites-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      [
        'export function cfg() {',
        '  return 1 // cfg',
        '}',
        'export const other = cfg()',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(dir, 'src', 'b.ts'),
      ['import { cfg } from "./a.js"', 'const cfgX = cfg', ''].join('\n'),
    )
    writeFileSync(join(dir, 'notes.md'), 'call `cfg` first\n')
    writeFileSync(join(dir, 'src', 'untouched.ts'), 'const nothing = 1\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('finds code sites across files and annotates the enclosing symbol', async () => {
    const res = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })

    // a.ts: declaration + call (the trailing comment is masked out).
    // b.ts: import + the value in `const cfgX = cfg` (cfgX itself must not match).
    // notes.md: one unparsed site.
    expect(res.sites.length).toBe(5)
    expect(res.skippedMasked).toBe(1)
    expect(res.files.length).toBe(3)

    const declaration = res.sites.find(
      s => s.relPath.endsWith('a.ts') && s.line === 1,
    )
    expect(declaration?.symbol?.name).toBe('cfg')
    expect(declaration?.unparsed).toBe(false)

    const md = res.sites.find(s => s.relPath.endsWith('notes.md'))
    expect(md?.unparsed).toBe(true)
    expect(md?.symbol).toBeNull()
  })

  test('ids are dense, ordered, and the token is content-stable', async () => {
    const first = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })
    const second = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })

    expect(first.sites.map(s => s.id)).toEqual(['s01', 's02', 's03', 's04', 's05'])
    expect(second.sitesToken).toBe(first.sitesToken)
    // An untouched tree is served from the memo, so the permission pass and
    // the call that follows it don't each re-read every candidate file.
    expect(second).toBe(first)
  })

  test('the token changes when a site moves', async () => {
    const before = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })
    writeFileSync(join(dir, 'src', 'c.ts'), 'export const also = cfg\n')
    const after = await findSites({
      symbol: 'cfg',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })
    rmSync(join(dir, 'src', 'c.ts'))

    expect(after.sitesToken).not.toBe(before.sitesToken)
  })

  test('scope narrows the search', async () => {
    const res = await findSites({
      symbol: 'cfg',
      // Anchored globs resolve against ripgrep's own cwd (GrepTool behaves the
      // same way), so a scope for a temp dir has to be written unanchored.
      scope: '**/b.ts',
      cwd: dir,
      abortSignal: new AbortController().signal,
    })

    expect(res.files.length).toBe(1)
    expect(res.sites.every(s => s.relPath.endsWith('b.ts'))).toBe(true)
  })
})
