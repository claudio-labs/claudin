// Comments the elision guard must let through (review, 2026-11-08): a lone
// word (`other`, `previous`, `same`, `etc`) next to an ellipsis is prose, not a
// placeholder phrase, and a doc-comment continuation's ellipsis is an
// example's body. Before the fix all six were refused.
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
