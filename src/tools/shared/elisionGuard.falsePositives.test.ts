// the elision guard refuses ordinary comments. The agreed rule
// (plan, "Guard de elisão") needs a placeholder PHRASE on the line — `existing`,
// `rest of`, `remaining`, `unchanged`, `same as before`, `previous`,
// `other … (methods|functions|code)`. The module fires on a bare `...` and on
// the lone words `other`, `same`, `previous`, `etc`, so narrative comments
// that end with an ellipsis and doc-comment examples are refused.
import { describe, expect, test } from 'bun:test'
import { findElisionPlaceholder } from 'src/tools/shared/elisionGuard.js'

describe('elision guard: legitimate comments in new code', () => {
  const cases: Array<[string, string]> = [
    ['a.ts', '// Retry against the other replicas...\nretry()'],
    ['a.ts', '// Fall back to the previous value...\nreturn prev'],
    ['run.sh', '# Waiting for the same lock...\nflock 9'],
    ['a.py', '# Downloading models, datasets, etc...\nfetch()'],
    ['a.ts', '/**\n * @example\n * build({\n *   ...\n * })\n */\nexport function build() {}'],
    ['lib.rs', '/// let v = vec![\n///     ...\n/// ];\npub fn f() {}'],
  ]
  for (const [file, text] of cases) {
    test(`${file}: ${JSON.stringify(text.split('\n').find(l => l.includes('...')))}`, () => {
      expect(findElisionPlaceholder(text, '', file)).toBeNull()
    })
  }
})
