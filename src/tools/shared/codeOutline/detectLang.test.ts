import { describe, expect, test } from 'bun:test'

import {
  detectOutlineLang,
  detectOutlineLangFromPath,
  maskSourceForLang,
  scanSymbols,
} from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('detectOutlineLang', () => {
  test('maps known extensions, with or without a leading dot', () => {
    expect(detectOutlineLang('ts')).toBe('typescript')
    expect(detectOutlineLang('.tsx')).toBe('typescript')
    expect(detectOutlineLang('MTS')).toBe('typescript')
    expect(detectOutlineLang('js')).toBe('javascript')
    expect(detectOutlineLang('.jsx')).toBe('javascript')
    expect(detectOutlineLang('py')).toBe('python')
    expect(detectOutlineLang('go')).toBe('go')
    expect(detectOutlineLang('java')).toBe('java')
    expect(detectOutlineLang('kt')).toBe('kotlin')
    expect(detectOutlineLang('.kts')).toBe('kotlin')
    expect(detectOutlineLang('cs')).toBe('csharp')
    expect(detectOutlineLang('rs')).toBe('rust')
    expect(detectOutlineLang('md')).toBe('markdown')
    expect(detectOutlineLang('.markdown')).toBe('markdown')
  })

  test('maps the newly-added language extensions (case-insensitive)', () => {
    // C / C++ — a single 'c' language for every dialect extension.
    for (const ext of ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', '.CPP']) {
      expect(detectOutlineLang(ext)).toBe('c')
    }
    expect(detectOutlineLang('php')).toBe('php')
    expect(detectOutlineLang('.PHP')).toBe('php')
    expect(detectOutlineLang('swift')).toBe('swift')
    expect(detectOutlineLang('scala')).toBe('scala')
    expect(detectOutlineLang('rb')).toBe('ruby')
    expect(detectOutlineLang('lua')).toBe('lua')
    expect(detectOutlineLang('sh')).toBe('bash')
    expect(detectOutlineLang('bash')).toBe('bash')
    expect(detectOutlineLang('sql')).toBe('sql')
    expect(detectOutlineLang('.SQL')).toBe('sql')
    expect(detectOutlineLang('css')).toBe('css')
    expect(detectOutlineLang('scss')).toBe('css')
    expect(detectOutlineLang('html')).toBe('html')
    expect(detectOutlineLang('htm')).toBe('html')
    // Config / markup / build extensions
    expect(detectOutlineLang('yaml')).toBe('yaml')
    expect(detectOutlineLang('.YML')).toBe('yaml')
    expect(detectOutlineLang('xml')).toBe('xml')
    expect(detectOutlineLang('properties')).toBe('properties')
    expect(detectOutlineLang('env')).toBe('env')
    expect(detectOutlineLang('ini')).toBe('properties')
    expect(detectOutlineLang('toml')).toBe('toml')
    expect(detectOutlineLang('graphql')).toBe('graphql')
    expect(detectOutlineLang('gql')).toBe('graphql')
    expect(detectOutlineLang('mk')).toBe('makefile')
    expect(detectOutlineLang('tf')).toBe('terraform')
    expect(detectOutlineLang('hcl')).toBe('terraform')
    // Extensionless filenames
    expect(detectOutlineLang('dockerfile')).toBe('dockerfile')
    expect(detectOutlineLang('containerfile')).toBe('dockerfile')
    expect(detectOutlineLang('makefile')).toBe('makefile')
  })

  test('detectOutlineLangFromPath handles extensionless filenames', () => {
    expect(detectOutlineLangFromPath('Dockerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Dockerfile.dev')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('/path/to/Dockerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Containerfile')).toBe('dockerfile')
    expect(detectOutlineLangFromPath('Makefile')).toBe('makefile')
    expect(detectOutlineLangFromPath('Makefile.am')).toBe('makefile')
    expect(detectOutlineLangFromPath('/repo/Makefile')).toBe('makefile')
    // Regular extensions still work
    expect(detectOutlineLangFromPath('config.yaml')).toBe('yaml')
    expect(detectOutlineLangFromPath('/app/src/schema.graphql')).toBe('graphql')
    expect(detectOutlineLangFromPath('main.tf')).toBe('terraform')
    // Unknown → null
    expect(detectOutlineLangFromPath('readme.txt')).toBeNull()
    // Extension-only keys (env, properties, ini, xml, …) must NOT match a
    // basename prefix — otherwise `env.log` / `properties.txt` get routed to
    // the config scanner and produce a garbage key outline. Only the true
    // extensionless basenames (dockerfile/containerfile/makefile) match.
    expect(detectOutlineLangFromPath('env.log')).toBeNull()
    expect(detectOutlineLangFromPath('properties.txt')).toBeNull()
    expect(detectOutlineLangFromPath('ini.settings')).toBeNull()
    expect(detectOutlineLangFromPath('xml.data')).toBeNull()
    expect(detectOutlineLangFromPath('toml.notes.md')).toBe('markdown')
  })

  test('returns null for unsupported extensions', () => {
    expect(detectOutlineLang('json')).toBeNull()
    expect(detectOutlineLang('txt')).toBeNull()
    expect(detectOutlineLang('')).toBeNull()
  })
})

describe('scanSymbols — review regression fixes', () => {
  test('detects dotenv variants and GNUmakefile', () => {
    expect(detectOutlineLangFromPath('.env.local')).toBe('env')
    expect(detectOutlineLangFromPath('/app/.env.production')).toBe('env')
    expect(detectOutlineLangFromPath('.env.example')).toBe('env')
    expect(detectOutlineLangFromPath('GNUmakefile')).toBe('makefile')
    // The extension-key guard still holds.
    expect(detectOutlineLangFromPath('env.log')).toBeNull()
    expect(detectOutlineLangFromPath('.envrc')).toBeNull()
  })

  test('Ruby 3 endless methods do not unbalance the outline', () => {
    const src = [
      'class Basket',
      '  def size = @items.count',
      '  def total(tax) = @sum * tax',
      '',
      '  def add(item)',
      '    @items << item',
      '  end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(syms.map(s => s.name).sort()).toEqual([
      'Basket',
      'add',
      'size',
      'total',
    ])
    expect(byName.size).toMatchObject({ startLine: 2, endLine: 2 })
    expect(byName.total).toMatchObject({ startLine: 3, endLine: 3 })
    expect(byName.Basket).toMatchObject({ startLine: 1, endLine: 8 })
  })

  test('Ruby setter defs (`def value=(v)`) still close on `end`', () => {
    const src = [
      'class Cfg',
      '  def value=(v)',
      '    @v = v',
      '  end',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'ruby')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['value=']).toMatchObject({ startLine: 2, endLine: 4 })
    expect(byName.Cfg).toMatchObject({ endLine: 5 })
  })

  test('Lua mid-line openers keep the stack balanced', () => {
    const src = [
      'function M.tick(y)',
      '  x = 1; if y then',
      '    x = 2',
      '  end',
      '  return x',
      'end',
      '',
      'function M.other()',
      '  return 0',
      'end',
    ].join('\n')
    const syms = scanSymbols(src, 'lua')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(syms.map(s => s.name)).toEqual(['tick', 'other'])
    expect(byName.tick).toMatchObject({ startLine: 1, endLine: 6 })
    expect(byName.other).toMatchObject({ startLine: 8, endLine: 10 })
  })

  test('CSS protocol-relative url(//…) is not treated as a SCSS comment', () => {
    const src = [
      '.hero { background: url(//cdn.example.com/x.png) }',
      '',
      '.next {',
      '  color: red;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')

    expect(syms.map(s => s.name)).toEqual(['.hero', '.next'])
  })

  test('Dockerfile comments inside a continuation keep it open', () => {
    const src = [
      'FROM node:20 AS base',
      'RUN echo start \\',
      '  # note — Docker keeps the continuation open across comments',
      '  COPY . .',
      'ENV FOO=bar',
    ].join('\n')
    const syms = scanSymbols(src, 'dockerfile')

    // `COPY . .` is continuation text of the RUN, not a real instruction.
    expect(syms.map(s => s.name)).toEqual(['base', 'RUN', 'ENV'])
  })

  test('HTML heading text strips nested/split tags to a fixpoint', () => {
    const src = [
      '<html><body>',
      '<h1>Intro <scr<b>ipt>alert</h1>',
      '</body></html>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const h1 = syms.find(s => s.signature.includes('<h1>'))

    expect(h1).toBeDefined()
    // No complete tag (and no dangling `<`) survives in the outline text.
    expect(h1!.name).not.toMatch(/</)
  })
})

describe('languages added for Rename', () => {
  test('shell dialects reuse the bash scanner', () => {
    for (const ext of ['sh', 'bash', 'zsh', 'ksh', 'fish']) {
      expect(detectOutlineLangFromPath(`/tmp/x.${ext}`)).toBe('bash')
    }
  })

  test('the new extensions map to their language', () => {
    expect(detectOutlineLangFromPath('/a/lib.dart')).toBe('dart')
    expect(detectOutlineLangFromPath('/a/build.gradle')).toBe('groovy')
    expect(detectOutlineLangFromPath('/a/x.groovy')).toBe('groovy')
    expect(detectOutlineLangFromPath('/a/mod.ex')).toBe('elixir')
    expect(detectOutlineLangFromPath('/a/run.exs')).toBe('elixir')
    expect(detectOutlineLangFromPath('/a/deploy.ps1')).toBe('powershell')
    expect(detectOutlineLangFromPath('/a/mod.psm1')).toBe('powershell')
  })

  // The reason maskElixir exists instead of reusing maskRuby: Ruby reads
  // `<<"tag">>` as a heredoc opener and masks everything after it.
  test("elixir: a binary literal is not a heredoc", () => {
    const src = 'a = <<"tag">>\ndef keep(cfg), do: cfg\n'
    const masked = maskSourceForLang(src, 'elixir')!

    expect(masked.slice(src.indexOf('def keep'), src.indexOf('def keep') + 8)).toBe(
      'def keep',
    )
    // The same source under Ruby's mask is what the dedicated scanner avoids.
    const asRuby = maskSourceForLang(src, 'ruby')!
    expect(asRuby.includes('def keep')).toBe(false)
  })

  test('powershell: here-strings and literal strings', () => {
    const here = '$a = @"\nvalue: $HIT\n"@\n$b = @\'\nMISS\n\'@\n'
    const masked = maskSourceForLang(here, 'powershell', {
      stringInterpolations: true,
    })!

    expect(masked.slice(here.indexOf('HIT'), here.indexOf('HIT') + 3)).toBe('HIT')
    expect(masked.slice(here.indexOf('MISS'), here.indexOf('MISS') + 4)).toBe('    ')
  })

  test('mask-only languages resolve no symbols and do not throw', () => {
    expect(scanSymbols('def cfgValue(n), do: n\n', 'elixir')).toEqual([])
    expect(scanSymbols('function cfgValue { 1 }\n', 'powershell')).toEqual([])
  })

  // `if !(x)` puts `!(` on the line before the literal without being a macro
  // call. Reading that as a format string exposes the string's contents to a
  // rename, which rewrites text the user never meant to touch.
  test('rust: ordinary negation is not a format macro', () => {
    const negation = 'fn f(){ if !(x) { let s = "{name}"; } }'
    const masked = maskSourceForLang(negation, 'rust', {
      stringInterpolations: true,
    })!
    expect(masked.includes('name')).toBe(false)

    for (const macro of ['format', 'println', 'write', 'panic', 'assert']) {
      const src = `fn f(){ ${macro}!("{name}"); }`
      const m = maskSourceForLang(src, 'rust', { stringInterpolations: true })!
      expect(m.slice(src.indexOf('name'), src.indexOf('name') + 4)).toBe('name')
    }
  })

  // `"$foo$bar"` is two references. If the first identifier scan swallows the
  // second sigil, that `$` survives unblanked and reads as an identifier
  // character — which silently drops BOTH sites.
  test('adjacent bare sigils are two separate references', () => {
    for (const [lang, src] of [
      ['kotlin', 'val s = "$foo$bar"'],
      ['groovy', 'def s = "$foo$bar"'],
      ['dart', 'final s = "$foo$bar";'],
    ] as const) {
      const masked = maskSourceForLang(src, lang, {
        stringInterpolations: true,
      })!
      expect(masked).not.toContain('$')
      expect(masked.slice(src.indexOf('foo'), src.indexOf('foo') + 3)).toBe('foo')
      expect(masked.slice(src.indexOf('bar'), src.indexOf('bar') + 3)).toBe('bar')
    }
  })
})
