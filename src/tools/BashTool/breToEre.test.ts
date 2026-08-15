import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { breToEre } from 'src/tools/BashTool/breToEre.js'
import { ripgrepCommand } from 'src/shared/fs/ripgrep.js'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/breCorpus.txt',
)

/**
 * Each row is [BRE pattern, expected ERE, what it pins]. A row whose expected
 * value is null must NOT translate — the caller falls back to the shell.
 *
 * Every non-null row is ALSO run through the differential test below, which
 * puts the BRE in front of the real `grep`, the TRANSLATOR'S OWN OUTPUT in
 * front of the real `rg`, and demands the same lines. Feeding it the
 * translator's output rather than the column above is the load-bearing choice:
 * with the expected value there, the differential would only ever pin this
 * table against POSIX and a wrong translation would pass it.
 */
const ROWS: [string, string | null, string][] = [
  // The case the feature exists for.
  ['foo\\|bar', 'foo|bar', 'BRE alternation becomes a real alternation'],
  ['foo|bar', 'foo\\|bar', 'a bare pipe is a literal in BRE and must stay one'],
  [
    'Addic7ed\\|YIFY\\|^## ',
    'Addic7ed|YIFY|^## ',
    'an anchor after \\| is a real anchor — the shape from the session',
  ],

  // Groups and intervals: the metacharacter moves to the other side of the \.
  ['\\(ab\\)*c', '(ab)*c', 'a BRE group becomes an ERE group'],
  ['a\\{2\\}', 'a{2}', 'a BRE interval becomes an ERE interval'],
  ['a\\{2,\\}', 'a{2,}', 'an open-ended interval'],
  ['a\\{2,3\\}', 'a{2,3}', 'a bounded interval'],
  ['(a)', '\\(a\\)', 'bare parens are literals in BRE'],
  ['a{2}', 'a\\{2\\}', 'bare braces are literals in BRE'],
  ['a+b', 'a\\+b', 'a bare plus is a literal in BRE'],
  ['a?b', 'a\\?b', 'a bare question mark is a literal in BRE'],
  ['a\\+b', 'a+b', 'GNU \\+ is a repetition'],
  ['a\\?b', 'a?b', 'GNU \\? is a repetition'],

  // Positional metacharacters — the rules a character class cannot see.
  ['^foo', '^foo', 'an anchor at the start stays an anchor'],
  ['foo$', 'foo$', 'an anchor at the end stays an anchor'],
  ['a^b', 'a\\^b', 'a caret mid-pattern is a literal in BRE'],
  ['bar$baz', 'bar\\$baz', 'a dollar mid-pattern is a literal in BRE'],
  ['*foo', '\\*foo', 'a leading star is a literal in BRE'],
  ['^*foo', '^\\*foo', 'a star right after the anchor is still a literal'],
  ['\\(*a\\)', '(\\*a)', 'a star opening a group is a literal too'],
  ['a\\|*b', 'a|\\*b', 'and a star opening an alternation branch'],
  ['a*b', 'a*b', 'a star with an atom before it is a repetition in both'],
  ['foo$\\|^bar', 'foo$|^bar', 'anchors at the edges of each branch'],

  // Bracket expressions pass through untouched.
  ['[^f]oo', '[^f]oo', 'a caret inside a bracket is literal in both'],
  ['[]a]', '[]a]', 'a leading ] is a member of the class'],
  ['[[:alpha:]^]x', '[[:alpha:]^]x', 'a POSIX class does not desync the scan'],
  ['[a-c]*', '[a-c]*', 'a class is an atom, so the star repeats it'],

  // Escapes both engines agree on.
  ['a\\.b', 'a\\.b', 'an escaped dot is a literal in both'],
  ['fo\\w', 'fo\\w', 'GNU \\w is honored by both'],
  ['a\\\\b', 'a\\\\b', 'an escaped backslash is a literal in both'],

  // Refusals.
  ['\\(foo\\)\\1', null, 'rust-regex has no back-reference'],
  ['foo\\d', null, 'grep reads a literal d where rg reads a digit class'],
  ['[\\w]', null, 'a backslash inside a bracket is ordinary to grep only'],
  ['\\<word\\>', null, 'GNU word anchors have no version-independent spelling'],
  ['a**', null, 'stacked repetition is valid to grep, a parse error to rg'],
  ['a\\{2\\}*', null, 'the same, spelled with an interval'],
  ['\\{2\\}a', null, 'a leading interval has no atom to repeat'],
  ['\\(unclosed', null, 'an unclosed group is a grep error'],
  ['unopened\\)', null, 'and so is an unopened one'],
  ['a\\{2', null, 'an unterminated interval'],
  ['a\\{x\\}', null, 'a malformed interval body'],
  ['trailing\\', null, 'a trailing backslash is undefined'],
  ['[unclosed', null, 'an unclosed bracket aborts both engines'],
]

describe('breToEre', () => {
  for (const [bre, ere, why] of ROWS) {
    test(`${bre} → ${ere ?? 'null'} — ${why}`, () => {
      expect(breToEre(bre)).toBe(ere)
    })
  }

  test('an empty pattern survives as an empty pattern', () => {
    // `grep -n "" f` is the whole-file read the redirect maps to a Read, and
    // that branch runs AFTER this translation.
    expect(breToEre('')).toBe('')
  })

  test('a pattern with no metacharacters is returned unchanged', () => {
    expect(breToEre('AnimeKalesi')).toBe('AnimeKalesi')
  })
})

// ---------------------------------------------------------------------------
// Differential: the real grep against the real rg
// ---------------------------------------------------------------------------

const grepAvailable =
  spawnSync('grep', ['--version'], { encoding: 'utf8' }).status === 0

function runGrep(pattern: string): string {
  const { stdout } = spawnSync('grep', ['-n', '--', pattern, FIXTURE], {
    encoding: 'utf8',
  })
  return stdout ?? ''
}

function runRg(pattern: string): string {
  const { rgPath, rgArgs, argv0 } = ripgrepCommand()
  const { stdout } = spawnSync(
    rgPath,
    [
      ...rgArgs,
      '-n',
      '--case-sensitive',
      '--color=never',
      '-e',
      pattern,
      FIXTURE,
    ],
    { encoding: 'utf8', ...(argv0 !== undefined && { argv0 }) },
  )
  return stdout ?? ''
}

describe.skipIf(!grepAvailable)('breToEre — differential against grep', () => {
  test('the corpus is not silently empty', () => {
    // Guard against the whole suite passing because every pattern matched
    // nothing on both sides.
    expect(runGrep('release').split('\n').filter(Boolean)).toHaveLength(2)
  })

  for (const [bre, ere, why] of ROWS) {
    if (ere === null) continue
    test(`${bre} answers the same lines as ${ere} — ${why}`, () => {
      const translated = breToEre(bre)
      expect(translated).not.toBeNull()
      expect(runRg(translated!)).toBe(runGrep(bre))
    })
  }

  test('the untranslated pattern is what diverges', () => {
    // The point of the whole module, stated as a fact about these two
    // binaries: handing rg the BRE verbatim answers a DIFFERENT set of lines.
    expect(runRg('foo\\|bar')).not.toBe(runGrep('foo\\|bar'))
    expect(runRg('a^b')).not.toBe(runGrep('a^b'))
  })
})
