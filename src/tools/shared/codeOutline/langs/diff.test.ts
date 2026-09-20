import { describe, expect, test } from 'bun:test'

import {
  detectOutlineLang,
  maskSourceForLang,
  scanSymbols,
} from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — unified diff', () => {
  const GIT_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@ export function a() {',
    ' const x = 1',
    '-const y = 2',
    '+const y = 3',
    '+const z = 4',
    '@@ -10,2 +11,2 @@',
    '-old',
    '+new',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/README.md',
    '@@ -0,0 +1,2 @@',
    '+# Title',
    '+--- not a file boundary',
    '',
  ].join('\n')

  test('one symbol per file with counts, hunks nested under it', () => {
    const syms = scanSymbols(GIT_DIFF, 'diff')
    expect(syms.map(s => [s.name, s.kind, s.depth])).toEqual([
      ['src/a.ts', 'file', 0],
      ['@@ -1,3 +1,4 @@', 'hunk', 1],
      ['@@ -10,2 +11,2 @@', 'hunk', 1],
      ['README.md', 'file', 0],
      ['@@ -0,0 +1,2 @@', 'hunk', 1],
    ])
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    // `+++`/`---` header lines are not content; the `+--- not a file
    // boundary` line IS an addition and must not open a section.
    expect(byName['src/a.ts']).toMatchObject({
      signature: 'src/a.ts  +3/-2 (2 hunks)',
      startLine: 1,
      endLine: 12,
    })
    expect(byName['README.md']).toMatchObject({
      signature: 'README.md  +2/-0 (1 hunk)',
      startLine: 13,
      endLine: 19,
    })
    // A hunk runs to the line before the next header; the last one to the
    // end of its file section.
    expect(byName['@@ -1,3 +1,4 @@']).toMatchObject({ startLine: 5, endLine: 9 })
    expect(byName['@@ -10,2 +11,2 @@']).toMatchObject({ startLine: 10, endLine: 12 })
  })

  test('a diff whose `diff --git` headers were stripped still splits on the ---/+++ pair', () => {
    const src = [
      '--- a/lib/x.py',
      '+++ b/lib/x.py',
      '@@ -1 +1 @@',
      '-print(1)',
      '+print(2)',
      '--- a/lib/y.py',
      '+++ b/lib/y.py',
      '@@ -1 +1,2 @@',
      ' pass',
      '+--- a removed-looking content line',
    ].join('\n')
    const syms = scanSymbols(src, 'diff')
    expect(syms.filter(s => s.kind === 'file').map(s => s.name)).toEqual([
      'lib/x.py',
      'lib/y.py',
    ])
    expect(syms.find(s => s.name === 'lib/y.py')).toMatchObject({
      signature: 'lib/y.py  +1/-0 (1 hunk)',
      startLine: 6,
      endLine: 10,
    })
  })

  test('.diff and .patch map to the diff language; a diff-free file fails open', () => {
    expect(detectOutlineLang('.diff')).toBe('diff')
    expect(detectOutlineLang('patch')).toBe('diff')
    expect(scanSymbols('just prose\nno headers\n', 'diff')).toEqual([])
    expect(maskSourceForLang('--- a\n+++ b\n', 'diff')).toBeNull()
  })
})
