import { describe, expect, test } from 'bun:test'

import { maskSourceForLang } from 'src/tools/shared/codeOutline/scanSymbols.js'
import type { OutlineLang } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('maskSourceForLang', () => {
  // The whole point of the mask as an oracle: offsets must survive it, so a
  // match found at offset k in the source can be tested at offset k in the mask.
  const OFFSET_PRESERVING: Array<[string, OutlineLang]> = [
    ['const a = "x" // c\nfunction f() {}\n', 'typescript'],
    ['def f():\n    """doc"""\n    return "s"  # c\n', 'python'],
    ['fn f() { let s = "x"; /* c */ }\n', 'rust'],
    ['<?php\n// c\n$a = "x";\nfunction f() {}\n', 'php'],
    ['# c\nf() { echo "x"; }\n', 'bash'],
    ['def f\n  # c\n  "x"\nend\n', 'ruby'],
    ['-- c\nSELECT "x";\n', 'sql'],
    ['/* c */\n.a { color: red; }\n', 'css'],
    ['<!-- c -->\n<div id="x"></div>\n', 'xml'],
  ]

  test.each(OFFSET_PRESERVING)(
    'preserves length and newline offsets (%#)',
    (source, lang) => {
      const masked = maskSourceForLang(source, lang)
      expect(masked).not.toBeNull()
      expect(masked!.length).toBe(source.length)
      for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') expect(masked![i]).toBe('\n')
      }
    },
  )

  test('blanks comment and string bytes, keeps code bytes', () => {
    const src = 'const NAME = "NAME" // NAME\nfunction NAME() {}\n'
    const masked = maskSourceForLang(src, 'typescript')!
    const at = (needle: string, from = 0) => src.indexOf(needle, from)

    // Declaration on line 1 and the function name on line 2 are real code.
    expect(masked[at('NAME')]).toBe('N')
    expect(masked[at('NAME', at('function'))]).toBe('N')
    // The occurrence inside the string literal and inside the comment are not.
    expect(masked[at('NAME', at('"'))]).toBe(' ')
    expect(masked[at('NAME', at('//'))]).toBe(' ')
  })

  test('returns null for languages whose scanner does no masking', () => {
    for (const lang of [
      'markdown',
      'yaml',
      'toml',
      'properties',
      'env',
      'dockerfile',
      'makefile',
    ] as const) {
      expect(maskSourceForLang('anything: value\n', lang)).toBeNull()
    }
  })

  test('empty input is returned as-is, not null', () => {
    expect(maskSourceForLang('', 'typescript')).toBe('')
  })

  describe('stringInterpolations', () => {
    const SRC = 'const s = `a ${ NAME(1) } b`\n'

    test('is off by default — a template stays opaque for the outline', () => {
      const masked = maskSourceForLang(SRC, 'typescript')!

      expect(masked[SRC.indexOf('NAME')]).toBe(' ')
    })

    test('when on, the substitution body reads as code', () => {
      const masked = maskSourceForLang(SRC, 'typescript', {
        stringInterpolations: true,
      })!

      expect(masked[SRC.indexOf('NAME')]).toBe('N')
      // The literal text around it stays masked, and `${`/`}` are blanked as
      // punctuation so brace-depth math over the copy is unchanged.
      expect(masked[SRC.indexOf('a ${')]).toBe(' ')
      expect(masked[SRC.indexOf('${')]).toBe(' ')
      expect(masked[SRC.indexOf('} b')]).toBe(' ')
      expect(masked.length).toBe(SRC.length)
    })

    test('is ignored for Go, whose backtick string has no substitutions', () => {
      const go = 'q := `a ${ NAME } b`\n'
      const masked = maskSourceForLang(go, 'go', {
        stringInterpolations: true,
      })!

      expect(masked[go.indexOf('NAME')]).toBe(' ')
    })

    test('python f-string replacement fields read as code', () => {
      const py = 'a = f"x {NAME(1)} y"\nb = "{NAME}"\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe('N')
      // A plain (non-f) string stays opaque, braces or not.
      expect(masked[py.indexOf('NAME', py.indexOf('b ='))]).toBe(' ')
      expect(masked.length).toBe(py.length)
    })

    test('python f-string: doubled braces are literal text', () => {
      const py = 'a = f"{{NAME}} {NAME}"\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe(' ')
      expect(masked[py.lastIndexOf('NAME')]).toBe('N')
    })

    test('python f-string: prefix variants and triple quotes', () => {
      const py = 'a = rf"""x {NAME} y"""\n'
      const masked = maskSourceForLang(py, 'python', {
        stringInterpolations: true,
      })!

      expect(masked[py.indexOf('NAME')]).toBe('N')
    })

    test('python f-strings stay opaque by default', () => {
      const py = 'a = f"x {NAME(1)} y"\n'

      expect(maskSourceForLang(py, 'python')![py.indexOf('NAME')]).toBe(' ')
    })

    // One battery per language. `HIT` marks an occurrence the mask must leave
    // as code (a real reference); `MISS` marks one it must keep blanked (plain
    // string text). Both are ordinary identifiers, so the scanner sees no
    // difference — only its interpolation rules decide.
    const CASES: Array<{ lang: OutlineLang; src: string }> = [
      { lang: 'typescript', src: 'const a = `t ${HIT} MISS ${f(HIT)}`\n' },
      { lang: 'javascript', src: 'const a = `t ${HIT} MISS`\nconst b = "MISS"\n' },
      { lang: 'python', src: 'a = f"t {HIT} MISS"\nb = "MISS"\n' },
      { lang: 'kotlin', src: 'val a = "t $HIT MISS ${f(HIT)}"\nval b = "MISS"\n' },
      { lang: 'kotlin', src: 'val a = """t $HIT MISS"""\n' },
      { lang: 'scala', src: 'val a = s"t $HIT MISS ${f(HIT)}"\nval b = "MISS"\n' },
      { lang: 'csharp', src: 'var a = $"t {HIT} MISS";\nvar b = "MISS";\n' },
      { lang: 'swift', src: 'let a = "t \\(HIT) MISS"\nlet b = "MISS"\n' },
      // An escaped opener is literal text, not a field.
      { lang: 'javascript', src: 'const a = `t \\${MISS} MISS`\n' },
      { lang: 'bash', src: 'a="t \\$MISS MISS"\n' },
      { lang: 'ruby', src: 'a = "t #{HIT} MISS"\nb = \'MISS\'\nc = "MISS"\n' },
      { lang: 'php', src: '$a = "t $HIT MISS {$HIT}";\n$b = \'MISS\';\n' },
      { lang: 'bash', src: 'a="t $HIT MISS ${HIT}"\nb=\'MISS\'\n' },
      { lang: 'rust', src: 'let a = format!("t {HIT} MISS");\nlet b = "MISS";\n' },
      // Dart interpolates in both quote styles; an `r` prefix opts out.
      {
        lang: 'dart',
        src: "final a = \"t $HIT ${f(HIT)} MISS\";\nfinal b = r'$MISS';\n",
      },
      { lang: 'dart', src: "final a = '''t $HIT MISS''';\n" },
      // A Groovy GString is double-quoted only.
      {
        lang: 'groovy',
        src: "def a = \"t $HIT ${f(HIT)} MISS\"\ndef b = '$MISS'\n",
      },
      { lang: 'elixir', src: 'a = "t #{HIT} MISS"\n# MISS in a comment\n' },
      {
        lang: 'powershell',
        src: '$a = "t $HIT $(f $HIT) MISS"\n$b = \'$MISS\'\n',
      },
      // Backtick is PowerShell's escape character, so `$ is a literal dollar.
      { lang: 'powershell', src: '$a = "t `$MISS MISS"\n<# MISS #>\n' },
      // Controls — these languages have no interpolation at all, so every
      // occurrence inside a literal stays masked even with the flag on.
      { lang: 'go', src: 'a := `t ${MISS} MISS`\nb := "MISS"\n' },
      { lang: 'java', src: 'String a = "t ${MISS} MISS";\n' },
      { lang: 'lua', src: 'local a = "t ${MISS} MISS"\n' },
    ]

    const occurrences = (src: string, needle: string): number[] => {
      const out: number[] = []
      for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1)) {
        out.push(at)
      }
      return out
    }

    for (const { lang, src } of CASES) {
      const label = src.split('\n')[0]!
      test(`${lang}: ${label}`, () => {
        const masked = maskSourceForLang(src, lang, {
          stringInterpolations: true,
        })!

        expect(masked.length).toBe(src.length)
        for (const at of occurrences(src, 'HIT')) {
          expect(masked.slice(at, at + 3)).toBe('HIT')
        }
        for (const at of occurrences(src, 'MISS')) {
          expect(masked.slice(at, at + 4)).toBe('    ')
        }
        // Without the opt-in every language stays fully opaque.
        const opaque = maskSourceForLang(src, lang)!
        for (const at of occurrences(src, 'HIT')) {
          expect(opaque.slice(at, at + 3)).toBe('   ')
        }
      })
    }
  })
})
