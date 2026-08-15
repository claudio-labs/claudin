import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import {
  analyzeCommandForRedirect,
  MEMO_LIMIT,
  renderToolRedirect,
  resetToolRedirectMemoForTesting,
  shouldRedirectToTools,
  type SuggestedCall,
} from 'src/tools/BashTool/toolRedirect.js'

// Real files, because the analyzer refuses any path that is not a regular file
// on disk — a fixture-free existence gate is the point, not an inconvenience.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE_A = 'src/platform/bash/segments.ts'
const FILE_B = 'src/platform/bash/commands.ts'

function analyze(command: string) {
  return analyzeCommandForRedirect(command, REPO_ROOT)
}

function calls(command: string): SuggestedCall[] {
  const analysis = analyze(command)
  if (!analysis) throw new Error(`expected a redirect for: ${command}`)
  return analysis.units.flatMap(unit => unit.calls)
}

describe('file reads → Read', () => {
  test('cat maps to a whole-file Read with an absolute path', () => {
    expect(calls(`cat ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
    ])
  })

  test('cat -n is the same Read — Read numbers lines anyway', () => {
    expect(calls(`cat -n ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
    ])
  })

  test('nl maps to a whole-file Read', () => {
    expect(calls(`nl ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
    ])
  })

  test('several files become several Reads', () => {
    expect(calls(`cat ${FILE_A} ${FILE_B}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_B}`, view: 'full' },
    ])
  })

  test('a windowless Read asks for the body, not the auto-outline', () => {
    // Without view:'full', FileReadTool pivots a code file past its thresholds
    // to a structural outline — and `cat` promised the body. A windowed Read
    // never pivots, so it must NOT carry the flag.
    expect(calls(`cat ${FILE_A}`)[0]).toMatchObject({ view: 'full' })
    expect(calls(`head -n 50 ${FILE_A}`)[0]).not.toHaveProperty('view')
    expect(calls(`sed -n '330,$p' ${FILE_A}`)[0]).not.toHaveProperty('view')
  })

  test('head -n N becomes a limit', () => {
    expect(calls(`head -n 50 ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 50 },
    ])
  })

  test('bare head is the 10-line default', () => {
    expect(calls(`head ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 10 },
    ])
  })

  test('head -20 and head -n20 are the same as head -n 20', () => {
    const expected: SuggestedCall[] = [
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 20 },
    ]
    expect(calls(`head -20 ${FILE_A}`)).toEqual(expected)
    expect(calls(`head -n20 ${FILE_A}`)).toEqual(expected)
  })

  test("sed -n 'A,Bp' becomes offset + limit", () => {
    expect(calls(`sed -n '330,400p' ${FILE_A}`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 330,
        limit: 71,
      },
    ])
  })

  test("sed -n 'Np' is a single line", () => {
    expect(calls(`sed -n '42p' ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, offset: 42, limit: 1 },
    ])
  })

  test("sed -n 'A,$p' is open-ended", () => {
    expect(calls(`sed -n '330,$p' ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, offset: 330 },
    ])
  })

  test('grep -n "" is a whole-file read wearing a search\'s clothes', () => {
    expect(calls(`grep -n "" ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
    ])
  })
})

describe('pipeline fusion', () => {
  test('the case this feature exists for: grep -n "" F | sed -n A,Bp', () => {
    expect(calls(`grep -n "" ${FILE_A} | sed -n '330,400p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 330,
        limit: 71,
      },
    ])
  })

  test('cat F | head -n N', () => {
    expect(calls(`cat ${FILE_A} | head -n 50`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 50 },
    ])
  })

  test('selectors compose left to right, in the input coordinates', () => {
    // head takes lines 1-100; sed then takes lines 10-20 OF THAT, which are
    // lines 10-20 of the file.
    expect(calls(`cat ${FILE_A} | head -n 100 | sed -n '10,20p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 10,
        limit: 11,
      },
    ])
  })

  test('a selector that reaches past the upstream window is truncated, not extended', () => {
    // head gives 20 lines; asking for 10..40 of those can only yield 11.
    expect(calls(`cat ${FILE_A} | head -n 20 | sed -n '10,40p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 10,
        limit: 11,
      },
    ])
  })

  test('cat -n in a pipe is a no-op selector', () => {
    expect(calls(`cat ${FILE_A} | cat -n`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, view: 'full' },
    ])
  })

  test('a limit past Read’s ceiling is clamped and says so', () => {
    const [call] = calls(`sed -n '1,5000p' ${FILE_A}`)
    expect(call).toEqual({
      tool: 'Read',
      file_path: `${REPO_ROOT}/${FILE_A}`,
      limit: 2000,
      clamped: true,
    })
  })
})

// The single most common shape the shell was still being used for, measured
// over the local transcripts: `grep … | head -N` and its `| sed -n A,Bp`
// sibling. A Grep head used to sink the whole pipeline for want of a line
// window; `head_limit`/`offset` are that window.
describe('search pipelines fold into the Grep call', () => {
  test('| head -N becomes head_limit', () => {
    expect(calls(`grep -n foo ${FILE_A} | head -n 20`)).toEqual([
      {
        tool: 'Grep',
        pattern: 'foo',
        path: FILE_A,
        glob: undefined,
        output_mode: 'content',
        caseInsensitive: false,
        context: undefined,
        walksTree: undefined,
        head_limit: 20,
      },
    ])
  })

  test("| sed -n 'A,Bp' becomes offset + head_limit, and offset is 0-indexed", () => {
    // Grep's offset SKIPS n entries, so line 10 of the output is offset 9 —
    // unlike Read's own offset, which is the 1-indexed line number.
    expect(calls(`grep -rn foo src | sed -n '10,20p'`)[0]).toMatchObject({
      tool: 'Grep',
      offset: 9,
      head_limit: 11,
    })
  })

  test('a tree walk keeps its .gitignore warning through the fold', () => {
    expect(calls('grep -rn foo src | head -20')[0]).toMatchObject({
      walksTree: true,
      head_limit: 20,
    })
  })

  test('--include and -i survive the fold', () => {
    expect(
      calls('grep -rin foo src --include=*.ts --include=*.tsx | head -n 30')[0],
    ).toMatchObject({
      glob: '*.{ts,tsx}',
      caseInsensitive: true,
      head_limit: 30,
    })
  })

  test('count mode folds too', () => {
    expect(calls('rg --no-heading -c foo src | head -10')[0]).toMatchObject({
      output_mode: 'count',
      head_limit: 10,
    })
  })

  test('an unfolded Grep carries neither field', () => {
    const [call] = calls('grep -rn foo src')
    expect(call).not.toHaveProperty('offset')
    expect(call).not.toHaveProperty('head_limit')
  })
})

describe('searches → Grep', () => {
  test('recursive grep with a path and includes', () => {
    expect(calls('grep -rn "foo" src --include=*.ts')).toEqual([
      {
        tool: 'Grep',
        pattern: 'foo',
        path: 'src',
        glob: '*.ts',
        output_mode: 'content',
        caseInsensitive: false,
        context: undefined,
        walksTree: true,
      },
    ])
  })

  test('two --include flags collapse into one brace glob', () => {
    const [call] = calls('grep -rn "foo" src --include=*.ts --include=*.tsx')
    expect(call).toMatchObject({ tool: 'Grep', glob: '*.{ts,tsx}' })
  })

  test('a grep without -i asks for case-sensitive matching, explicitly', () => {
    // Grep applies ripgrep SMART-CASE when the caller says nothing, so a
    // lowercase pattern matches any case — while the `grep` being replaced
    // matched only the case it was given. Leaving the field off is the bug;
    // `false` is what reproduces the command.
    const command = `grep -n "animekalesi" ${FILE_A}`
    expect(calls(command)[0]).toMatchObject({ caseInsensitive: false })
    expect(renderToolRedirect(analyze(command)!)).toContain('"-i": false')
  })

  test('and -i still travels as true', () => {
    const command = `grep -in "animekalesi" ${FILE_A}`
    expect(calls(command)[0]).toMatchObject({ caseInsensitive: true })
    expect(renderToolRedirect(analyze(command)!)).toContain('"-i": true')
  })
})

// grep without -E is BRE, and the redirect used to stand every divergent BRE
// pattern down. Now it translates (breToEre.ts) — these rows are the ones that
// used to sit in the stand-down table. The translation's own equivalence is
// pinned against the real grep and the real rg in breToEre.test.ts; what these
// pin is that the redirect FIRES and carries the translated pattern.
describe('BRE patterns are translated, not refused', () => {
  const TRANSLATED: [string, string, string][] = [
    [`grep -rn "foo\\|bar" src`, 'foo|bar', 'the alternation the model writes'],
    ['grep -rn "foo|bar" src', 'foo\\|bar', 'a bare pipe stays a literal'],
    [`grep -rn "a\\{2\\}" ${FILE_A}`, 'a{2}', 'an interval'],
    ['grep -rn "a+b" src', 'a\\+b', 'a literal plus'],
    ['grep -rn "a?b" src', 'a\\?b', 'a literal question mark'],
    [`grep -c "a^b" ${FILE_A}`, 'a\\^b', 'a caret mid-pattern'],
    // Single-quoted on purpose: in double quotes `$baz` is an expansion, which
    // stands the segment down at argvOf before the dialect ever matters.
    [`grep -c 'bar$baz' ${FILE_A}`, 'bar\\$baz', 'a dollar mid-pattern'],
    [`grep -c "*foo" ${FILE_A}`, '\\*foo', 'a leading star'],
    [`grep -c "^*foo" ${FILE_A}`, '^\\*foo', 'a star after the anchor'],
  ]
  for (const [command, pattern, why] of TRANSLATED) {
    test(`${command} → ${pattern} — ${why}`, () => {
      expect(calls(command)[0]).toMatchObject({ pattern, translated: true })
    })
  }

  test('the session command that motivated this', () => {
    const command = `grep -n "Addic7ed\\|YIFY\\|^## " ${FILE_A}`
    expect(calls(command)[0]).toMatchObject({
      tool: 'Grep',
      pattern: 'Addic7ed|YIFY|^## ',
      caseInsensitive: false,
    })
  })

  test('a pattern the translation leaves alone is not flagged', () => {
    // `translated` drives a note in the message, so it must mean "rewritten",
    // not "went through the BRE arm".
    expect(calls(`grep -n "AnimeKalesi" ${FILE_A}`)[0]).not.toHaveProperty(
      'translated',
    )
  })

  test('the message says the pattern was converted', () => {
    const analysis = analyze(`grep -rn "foo\\|bar" src`)
    const message = renderToolRedirect(analysis!)
    expect(message).toContain('Grep(pattern: "foo|bar"')
    expect(message).toContain('it was converted')
  })

  test('and says nothing when nothing was converted', () => {
    const message = renderToolRedirect(analyze(`grep -rn "foo" src`)!)
    expect(message).not.toContain('it was converted')
  })

  test('-c maps to count mode, -l to files_with_matches', () => {
    expect(calls(`grep -c foo ${FILE_A}`)[0]).toMatchObject({
      output_mode: 'count',
    })
    expect(calls('grep -rl foo src')[0]).toMatchObject({
      output_mode: 'files_with_matches',
    })
  })

  test('-i and -C carry over', () => {
    expect(calls('grep -rin foo src -C 3')[0]).toMatchObject({
      caseInsensitive: true,
      context: { flag: '-C', lines: 3 },
    })
  })

  test('-h is accepted on a single file — the prefix it suppresses is redundant there', () => {
    // Grep always prints `file:line:`. With one file that is noise the model
    // can ignore; over a tree it is the answer to a question it asked NOT to
    // be answered, so those forms stand down (see "stands down").
    expect(calls(`grep -hc foo ${FILE_A}`)[0]).toMatchObject({
      tool: 'Grep',
      path: FILE_A,
      output_mode: 'count',
    })
    // Clustered with -E, the shape the transcripts actually carry.
    expect(calls(`grep -hEc "foo|bar" ${FILE_A}`)[0]).toMatchObject({
      output_mode: 'count',
      pattern: 'foo|bar',
    })
  })

  test('rg --no-heading is a no-op for the mapping', () => {
    // Without it rg groups matches under a filename header; with it (and by
    // default into a pipe) it prints the file:line: form Grep returns anyway.
    expect(calls('rg --no-heading -n foo src')[0]).toMatchObject({
      tool: 'Grep',
      pattern: 'foo',
      path: 'src',
    })
  })

  test('rg is recursive without -r', () => {
    expect(calls('rg -n foo src')[0]).toMatchObject({
      tool: 'Grep',
      pattern: 'foo',
      path: 'src',
    })
  })

  test('rg is not flagged as diverging — it honors .gitignore itself', () => {
    // walksTree exists only to warn that the two file sets differ. rg and the
    // Grep tool are the same engine under the same ignore rules, so flagging
    // the rg form would put a false statement in the refusal message.
    expect(calls('rg -n foo src')[0]).toMatchObject({ walksTree: undefined })
    expect(calls('rg -n foo')[0]).toMatchObject({ walksTree: undefined })
    // …while the grep form, which does diverge, keeps the flag.
    expect(calls('grep -rn foo src')[0]).toMatchObject({ walksTree: true })
  })

  test('an extended-regex dialect survives — it is what Grep speaks', () => {
    // -E and egrep both mean ERE, which is the dialect Grep hands to ripgrep.
    expect(calls('grep -rnE "foo|bar" src')[0]).toMatchObject({
      pattern: 'foo|bar',
    })
    expect(calls('egrep -rn "foo|bar" src')[0]).toMatchObject({
      pattern: 'foo|bar',
    })
  })

  test('ERE escapes both engines share keep the redirect', () => {
    // The ERE gate only fires on an alphanumeric escape ripgrep reads
    // differently — \w is shared, and \. is not alphanumeric at all.
    expect(calls('grep -rnE "fo\\w" src')[0]).toMatchObject({
      pattern: 'fo\\w',
    })
    expect(calls('grep -rnE "foo\\.bar" src')[0]).toMatchObject({
      pattern: 'foo\\.bar',
    })
    expect(calls('grep -rnE "\\w+TODO" src')[0]).toMatchObject({
      pattern: '\\w+TODO',
    })
  })

  test('ERE repetition after a caret keeps the redirect — both engines agree', () => {
    // ripgrep accepts anchor repetition, so `^*a` answers the same rows in
    // grep -E and rg (verified 4=4) — only the start/(/| positions gate.
    expect(calls('grep -rnE "^*a" src')[0]).toMatchObject({ pattern: '^*a' })
  })

  test('a POSIX character class does not desync the bracket scan', () => {
    // The `]` closing [:alpha:] must not end the bracket expression early,
    // or the `^` after it reads as a mid-pattern anchor and stands down.
    expect(calls('grep -rn "[[:alpha:]^]x" src')[0]).toMatchObject({
      pattern: '[[:alpha:]^]x',
    })
  })

  test('anchors at the pattern edges keep the redirect — both engines agree', () => {
    expect(calls('grep -rn "^foo" src')[0]).toMatchObject({ pattern: '^foo' })
    expect(calls('grep -rn "foo$" src')[0]).toMatchObject({ pattern: 'foo$' })
  })

  test('a negated bracket expression keeps the redirect', () => {
    // `^` inside [...] is literal in both dialects; the anchor gate must not
    // overreach into brackets.
    expect(calls('grep -rn "[^f]oo" src')[0]).toMatchObject({
      pattern: '[^f]oo',
    })
  })

  test('a bracket expression with a literal ] first keeps the redirect', () => {
    // A `]` in first position inside [...] is a literal member of the class
    // in both engines; the bracket scanner must not end the class there.
    expect(calls('grep -rn "[]a]" src')[0]).toMatchObject({
      pattern: '[]a]',
    })
  })

  test('a tree-walking grep is flagged so the message can name .gitignore', () => {
    // rg honors .gitignore, grep -r does not — over the repo root or a
    // directory the result sets differ; over a single file they agree.
    expect(calls('grep -rn TODO .')[0]).toMatchObject({ walksTree: true })
    expect(calls('grep -rn foo src')[0]).toMatchObject({ walksTree: true })
    // GNU grep -r with no FILE searches the cwd — a tree walk like any other.
    expect(calls('grep -rn foo')[0]).toMatchObject({ walksTree: true })
    expect(calls(`grep -rn foo ${FILE_A}`)[0]).toMatchObject({
      walksTree: undefined,
    })
    expect(calls(`grep -n foo ${FILE_A}`)[0]).toMatchObject({
      walksTree: undefined,
    })
  })
})

describe('discovery → Glob', () => {
  test('find DIR -name PAT', () => {
    expect(calls('find src -name "*.ts"')).toEqual([
      { tool: 'Glob', pattern: '**/*.ts', path: 'src' },
    ])
  })

  test('find . -name PAT drops the redundant root', () => {
    expect(calls('find . -name "*.ts"')).toEqual([
      { tool: 'Glob', pattern: '**/*.ts', path: undefined },
    ])
  })

  test('-type f alone still maps', () => {
    expect(calls('find src -type f')).toEqual([
      { tool: 'Glob', pattern: '**/*', path: 'src' },
    ])
  })

  test('find DIR -iname PAT carries the case flag', () => {
    expect(calls('find src -iname "*.TS"')).toEqual([
      { tool: 'Glob', pattern: '**/*.TS', path: 'src', caseInsensitive: true },
    ])
  })

  test('a plain -name does NOT carry it — Glob is sensitive by default', () => {
    // The flag has to be absent, not false: it drives the `"-i": true` the
    // message prints, and Glob's default already matches `find -name`.
    expect(calls('find src -name "*.ts"')[0]).not.toHaveProperty(
      'caseInsensitive',
    )
  })

  test('the rendered call spells the flag the tool takes', () => {
    const analysis = analyze('find src -iname "*.TS"')
    expect(renderToolRedirect(analysis!)).toContain(
      'Glob(pattern: "**/*.TS", path: "src", "-i": true)',
    )
  })
})

describe('a file source piped into grep', () => {
  test('cat f | grep PAT is one Grep over f', () => {
    expect(calls(`cat ${FILE_A} | grep -n foo`)).toMatchObject([
      {
        tool: 'Grep',
        pattern: 'foo',
        path: `${REPO_ROOT}/${FILE_A}`,
        output_mode: 'content',
      },
    ])
  })

  test('a whole-file sed range counts as the whole file', () => {
    expect(calls(`sed -n '1,$p' ${FILE_A} | grep foo`)).toMatchObject([
      { tool: 'Grep', pattern: 'foo', path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })

  test('a trailing selector still folds, now onto the Grep', () => {
    expect(calls(`cat ${FILE_A} | grep -n foo | head -5`)).toMatchObject([
      { tool: 'Grep', pattern: 'foo', head_limit: 5 },
    ])
  })

  test('grep -c over a piped file keeps the count mode', () => {
    // Over ONE file grep prints the bare count whether it reads the file or
    // stdin, so the count is reproducible where `-l` is not.
    expect(calls(`cat ${FILE_A} | grep -c foo`)).toMatchObject([
      { tool: 'Grep', output_mode: 'count' },
    ])
  })

  test('the Read is gone — the pipeline is not a read plus a search', () => {
    expect(calls(`cat ${FILE_A} | grep -n foo`)).toHaveLength(1)
  })
})

describe('compound commands', () => {
  test('the exact command from the bug report', () => {
    const command = `grep -n "" ${FILE_A} | sed -n '330,400p' && echo "=== call sites ===" && grep -rn "walkCommandSegments" src --include=*.ts --include=*.tsx`
    const analysis = analyze(command)
    expect(analysis).not.toBeNull()
    // The echo is neutral and contributes no unit.
    expect(analysis!.units).toHaveLength(2)
    expect(analysis!.units[0]!.calls[0]).toMatchObject({
      tool: 'Read',
      offset: 330,
      limit: 71,
    })
    expect(analysis!.units[1]!.calls[0]).toMatchObject({
      tool: 'Grep',
      glob: '*.{ts,tsx}',
    })
    expect(analysis!.targets).toEqual(['Read', 'Grep'])
  })

  test('a chain of reads is all-or-nothing — one unmappable segment passes', () => {
    expect(analyze(`bun run build && cat ${FILE_A}`)).toBeNull()
  })

  test('an echo-only command is not a redirect', () => {
    expect(analyze('echo hello')).toBeNull()
  })
})

describe('stands down', () => {
  const NOT_REDIRECTED: Array<[string, string]> = [
    // The pipeline's tail is not a line selector — this is the case where the
    // shell genuinely wins.
    [`cat package.json | jq '.scripts'`, 'post-processing with jq'],
    [`cat ${FILE_A} | wc -l`, 'counting, not reading'],
    // `sort` is not a selector, so the pipeline stands down even though the
    // head maps and `| head -n 5` alone would now fold in (see the Grep-window
    // tests). This is the isolating fixture for "one bad segment sinks it".
    [`grep -rn foo src | sort | uniq -c`, 'aggregation'],
    // Output goes to a file, not into context.
    [`cat ${FILE_A} > /tmp/out`, 'redirected to a file'],
    [`grep -rn foo src >> /tmp/out`, 'appended to a file'],
    // The shell runs one branch; suggesting both invents a read.
    [`cat ${FILE_A} || cat ${FILE_B}`, 'only the first branch would have run'],
    // Flags with no tool spelling.
    // -h asked for output WITHOUT filenames; over a tree or with no path at
    // all the suggested Grep would answer with exactly the prefixes it
    // suppressed, on many files.
    ['grep -rhn foo src', '-h over a directory'],
    ['grep -rh foo', '-h with no path at all'],
    // ripgrep gives -h to --help, so the short form must never map there.
    // A single FILE on purpose: over a directory the -h target guard would
    // absorb the rejection and the row would pass with this arm deleted.
    [`rg -hn foo ${FILE_A}`, "rg's -h is --help, not --no-filename"],
    [`rg --no-filename foo src`, '--no-filename over a directory'],
    // --no-heading is a ripgrep flag; grep would have failed on it, so mapping
    // it would redirect a command that never ran.
    [`grep --no-heading -n foo ${FILE_A}`, 'not a grep flag'],
    [`grep -v foo ${FILE_A}`, 'inverted match'],
    [`grep -o foo ${FILE_A}`, 'only-matching'],
    [`grep -P "\\d+" ${FILE_A}`, 'perl regex'],
    [`head -c 100 ${FILE_A}`, 'byte count, not lines'],
    // Isolates the head flag guard: a single positional file, so the
    // "several files banner" arm cannot absorb the rejection.
    [`head -q ${FILE_A}`, 'an unrecognised head flag'],
    [`cat -A ${FILE_A}`, 'shows non-printing characters'],
    // The BRE forms are TRANSLATED now, not refused — see the describe below.
    // What still stands down is a BRE construct with no ERE equivalent.
    ['rg "(foo)\\1" src', 'back-references have no ripgrep spelling'],
    [`grep -rn "\\(foo\\)\\1" ${FILE_A}`, 'a BRE back-reference, same problem'],
    [`grep -rn "\\<word\\>" ${FILE_A}`, 'GNU word anchors have no stable rg spelling'],
    [`grep -rn "a**" ${FILE_A}`, 'stacked repetition is a parse error to rg'],
    [`grep -rn "foo\\d" ${FILE_A}`, 'a BRE \\d is a literal d to grep, a class to rg'],
    [`grep -rn "[\\w]" ${FILE_A}`, 'a backslash inside a bracket'],
    // ERE: an alphanumeric escape the engines do not share. grep -E reads \d
    // as a literal d (matching "food"); rg reads a digit class (matching
    // "foo9") — same count, different lines, undetectable downstream.
    ['grep -Ern "foo\\d" src', 'an ERE \\d is a literal d to grep, a digit class to rg'],
    // ERE inside a bracket expression: POSIX makes the backslash ordinary,
    // so [\w] is the literals '\' and 'w' to grep (213 rows here) but a word
    // class to rg (777 rows); [\b] aborts rg outright.
    ['grep -Ern "[\\w]" src', 'a class escape is literal to grep, a word class to rg'],
    ['grep -Ern "[\\b]" src', 'grep reads a literal b where rg aborts on \\b in a class'],
    // ERE repetition with no preceding atom: a literal to grep (with a
    // stderr warning), a parse error to rg. After ^ they agree and pass.
    ['grep -rEn "*foo" src', 'a leading star is a literal to grep -E, a parse error to rg'],
    ['grep -rEn "(*a)" src', 'a star after ( is a literal to grep -E, a parse error to rg'],
    ['grep -rEn "a|?b" src', 'a question mark after | is a literal to grep -E, a parse error to rg'],
    ['grep -rEn "{2}a" src', 'a leading interval is a literal to grep -E, a parse error to rg'],
    [`sed -n '/a/,/b/p' ${FILE_A}`, 'regex range'],
    [`sed 's/a/b/' ${FILE_A}`, 'substitution'],
    [`sed -i 's/a/b/' ${FILE_A}`, 'in-place edit'],
    [`sed '330,400p' ${FILE_A}`, 'without -n every line prints, the range twice'],
    // An empty window is not a read. Without the guards these two carry
    // `limit: 0` and `limit: -99` into the suggested Read.
    [
      `cat ${FILE_A} | head -n 5 | sed -n '10,20p'`,
      'the selector starts past the upstream window',
    ],
    [`sed -n '400,300p' ${FILE_A}`, 'an inverted range selects nothing'],
    ['grep -rn "" src', 'an empty pattern over a tree is not a file read'],
    [`grep foo ${FILE_A} ${FILE_B}`, 'Grep searches one path'],
    ['grep TODO src', 'without -r, grep prints "Is a directory" and matches nothing'],
    [`cat ${FILE_A} | echo hi`, 'the read is discarded'],
    // A grep reading stdin only maps when an upstream segment named the file
    // AND handed over all of it — Grep cannot restrict a search to a slice.
    [
      `sed -n '1,400p' ${FILE_A} | grep foo`,
      'the shell searched a line slice, which Grep cannot express',
    ],
    [
      `head -n 100 ${FILE_A} | grep foo`,
      'same slice problem, spelled with head',
    ],
    ['grep foo', 'a bare stdin filter names no file at all'],
    [
      `cat ${FILE_A} | grep -l foo`,
      'grep -l over stdin answers "(standard input)", not the filename',
    ],
    [
      `cat ${FILE_A} ${FILE_B} | grep foo`,
      'two sources, so no single path for the Grep',
    ],
    [
      `cat ${FILE_A} | grep --include=*.ts foo`,
      'grep ignores --include on stdin; honoring it would narrow the search',
    ],
    [`cat ${FILE_A} | grep foo | grep bar`, 'a second filter has nothing to map to'],
    [
      'find src -name "*.ts" | grep foo',
      'a list of paths is not a file to search',
    ],
    [`find . -name "*.ts" -delete`, 'destructive predicate'],
    ['find src -type d', 'directories, which Glob does not return'],
    ['find src -maxdepth 2 -name "*.ts"', 'depth limit'],
    [`find ${FILE_A} -type f`, 'a file is not a walkable root'],
    // find's -path wildcards cross `/`; ripgrep's globset `*` stops at one
    // segment, so the only honest Glob for -path is none at all.
    ['find . -path "./src/*"', '-path has no equivalent Glob pattern'],
    ['find . -path "./src/*" -name "*.ts"', '-path poisons the whole predicate set'],
    // Expansions. The resolver hands the SOURCE text back, so a suggested
    // search for the literal `$PAT` would answer nothing and never say why.
    ['grep -rE "$PAT" src', 'a variable expansion is not a literal pattern'],
    ['grep -rE "${PAT}" src', 'a braced expansion is not a literal pattern'],
    ['grep -rE "pre$PAT" src', 'an expansion glued to a literal prefix'],
    ['grep -rE "$(id -u)" src', 'command substitution is not a literal pattern'],
    // No space inside the backticks on purpose: with one, shell-quote splits
    // the token and the trailing `-u\`` is rejected as an unknown flag, so the
    // substitution scan is never what stands it down.
    ['grep -rn `pat` src', 'backtick substitution is not a literal pattern'],
    ['find src -name "${N}.ts"', 'a variable expansion is not a literal glob'],
    // GrepTool excludes VCS metadata unconditionally, so the suggested call is
    // guaranteed empty while the shell command has real hits. Both roots exist
    // on disk, so the existence gate is not what rejects them.
    ['grep -rn foo .git', 'Grep excludes .git, so the suggested call answers nothing'],
    ['grep -rn foo .git/hooks', 'the exclusion applies at any depth'],
    // Out of scope on purpose.
    ['tail -f /tmp/log', 'tail is the Monitor tool’s job'],
    [`tail -n 20 ${FILE_A}`, 'last-N has no Read spelling'],
    ['ls src', 'Read’s own prompt sends directory listing to Bash'],
    [`awk 'NR>=1 && NR<=10' ${FILE_A}`, 'awk is out of scope'],
    // Nothing to read.
    ['cat /nonexistent/does-not-exist.ts', 'path does not exist'],
    ['cat /dev/null', 'not a regular file'],
    ['cat src', 'a directory, not a file'],
    ['grep foo', 'reads stdin'],
    [`head -n 50 ${FILE_A} ${FILE_B}`, 'head banners on multiple files'],
    [`sed -n '1,2p' ${FILE_A} ${FILE_B}`, 'sed concatenates, Read does not'],
    ['git log --oneline | head -20', 'the head is not a file read'],
    ['', 'empty'],
  ]
  for (const [command, why] of NOT_REDIRECTED) {
    test(`${command || '(empty)'} — ${why}`, () => {
      expect(analyze(command)).toBeNull()
    })
  }
})

describe('shouldRedirectToTools — one-shot escape hatch', () => {
  const anyTool: (name: string) => boolean = () => true
  const redirect = (command: string, hasTool: (name: string) => boolean = anyTool) =>
    shouldRedirectToTools(command, REPO_ROOT, hasTool)

  beforeEach(() => resetToolRedirectMemoForTesting())

  test('refuses the first attempt and runs the re-send', () => {
    const command = `cat ${FILE_A}`
    expect(redirect(command)).not.toBeNull()
    expect(redirect(command)).toBeNull()
    // The escape does not expire.
    expect(redirect(command)).toBeNull()
  })

  test('memoizes per command, not globally', () => {
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    expect(redirect(`cat ${FILE_B}`)).not.toBeNull()
  })

  test('surrounding whitespace does not buy a second refusal', () => {
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    expect(redirect(`  cat ${FILE_A}  `)).toBeNull()
  })

  test('a command that never redirects is never recorded', () => {
    expect(redirect('git status')).toBeNull()
    expect(redirect('git status')).toBeNull()
  })

  test('the memo evicts the oldest entry instead of clearing itself', () => {
    // Refuse MEMO_LIMIT + 21 distinct commands, then check an entry from the
    // middle: with FIFO eviction the set still holds the last MEMO_LIMIT, so
    // it keeps its escape. A wholesale clear would have dropped it and
    // re-armed a command that already spent its escape.
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    for (let line = 1; line <= MEMO_LIMIT + 20; line++) {
      expect(redirect(`sed -n '${line}p' ${FILE_A}`)).not.toBeNull()
    }
    expect(redirect(`sed -n '25p' ${FILE_A}`)).toBeNull()
  })

  test('the memo is bounded — a full memo evicts the oldest instead of growing', () => {
    // The observable difference between FIFO eviction and NO eviction at
    // all: with the eviction block deleted the set grows unboundedly and the
    // oldest command stays memoized forever; with FIFO it re-arms.
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    for (let line = 1; line <= MEMO_LIMIT; line++) {
      expect(redirect(`sed -n '${line}p' ${FILE_A}`)).not.toBeNull()
    }
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
  })

  test('stands down when a target tool is missing from the toolset', () => {
    const noGrep = (name: string) => name !== 'Grep'
    expect(redirect('grep -rn foo src', noGrep)).toBeNull()
    // …and the one-shot was NOT burned: with Grep present it still refuses.
    expect(redirect('grep -rn foo src')).not.toBeNull()
  })

  test('a mixed command needs every target, not just one', () => {
    const noGrep = (name: string) => name !== 'Grep'
    const command = `cat ${FILE_A} && grep -rn foo src`
    expect(redirect(command, noGrep)).toBeNull()
    expect(redirect(command)).not.toBeNull()
  })
})

describe('renderToolRedirect', () => {
  test('spells out each call with its arguments and the escape hatch', () => {
    const command = `grep -n "" ${FILE_A} | sed -n '330,400p' && grep -rn "foo" src --include=*.ts`
    const analysis = analyze(command)!
    const message = renderToolRedirect(analysis)
    expect(message).toContain(`Read(file_path: "${REPO_ROOT}/${FILE_A}"`)
    expect(message).toContain('offset: 330, limit: 71')
    expect(message).toContain('Grep(pattern: "foo", path: "src", glob: "*.ts"')
    expect(message).toContain('parallel tool_use blocks')
    expect(message).toContain('re-send this exact Bash command')
  })

  test('the folded window reaches the message', () => {
    // Without this the model is told to call Grep and left to guess the trim
    // it had spelled out in the shell.
    expect(renderToolRedirect(analyze('grep -rn foo src | head -20')!)).toContain(
      'head_limit: 20',
    )
    expect(
      renderToolRedirect(analyze(`grep -rn foo src | sed -n '10,20p'`)!),
    ).toContain('offset: 9, head_limit: 11')
  })

  test('a single call does not ask for parallel blocks', () => {
    const command = `cat ${FILE_A}`
    const message = renderToolRedirect(analyze(command)!)
    expect(message).not.toContain('parallel tool_use blocks')
  })

  test('names the clamp when it happened', () => {
    const command = `sed -n '1,5000p' ${FILE_A}`
    const message = renderToolRedirect(analyze(command)!)
    expect(message).toContain('clamped')
  })

  test('spells out view: "full" so the model can see the opt-out', () => {
    const command = `cat ${FILE_A}`
    expect(renderToolRedirect(analyze(command)!)).toContain('view: "full"')
  })

  test('names the .gitignore divergence for a tree-walking grep', () => {
    const message = renderToolRedirect(analyze('grep -rn TODO .')!)
    expect(message).toContain('.gitignore')
  })

  test('no .gitignore note for a single-file grep', () => {
    const message = renderToolRedirect(analyze(`grep -n foo ${FILE_A}`)!)
    expect(message).not.toContain('.gitignore')
  })

  test('no .gitignore note for rg — it honors .gitignore itself', () => {
    expect(renderToolRedirect(analyze('rg -n foo src')!)).not.toContain(
      '.gitignore',
    )
  })

  test('the divergence note also names Grep’s 250-entry cap', () => {
    // The other half of "the file sets differ": even over an identical set,
    // Grep truncates at head_limit and `grep -r` does not.
    const message = renderToolRedirect(analyze('grep -rn TODO .')!)
    expect(message).toContain('250')
    expect(message).toContain('head_limit')
  })

  test('the header agrees with the number of tools, and segments are numbered only when there are several', () => {
    const single = renderToolRedirect(analyze(`cat ${FILE_A}`)!)
    expect(single).toContain('is available.')
    expect(single).not.toContain('Segment')
    const compound = renderToolRedirect(
      analyze(`cat ${FILE_A} && grep -rn foo src`)!,
    )
    expect(compound).toContain('are available.')
    expect(compound).toContain('Segment 1 —')
    expect(compound).toContain('Segment 2 —')
  })
})

// ---------------------------------------------------------------------------
// Wiring. BashTool.tsx reaches src/terminal/ink.js through its import chain, so it
// cannot be imported under `bun test` (see .claudin/rules/testing.md). Without
// this block, deleting the call from validateInput leaves every test above
// green while the redirect never fires in production.
// ---------------------------------------------------------------------------

describe('BashTool wiring', () => {
  const src = readFileSync(new URL('./BashTool.tsx', import.meta.url), 'utf8')

  test('validateInput consults the redirect', () => {
    expect(src).toContain('shouldRedirectToTools(input.command, getCwd(),')
    expect(src).toContain('renderToolRedirect(toolRedirect)')
  })

  test('only for tools in this agent toolset', () => {
    expect(src).toContain(
      'name => findToolByName(context?.options?.tools ?? [], name) !== undefined',
    )
  })

  test('records a disparo so adoption is measurable, without paths', () => {
    expect(src).toContain("logEvent('tengu_bash_tool_redirect'")
    // Analytics metadata is numbers and booleans only — no command, no paths.
    expect(src).not.toContain('command: input.command')
  })

  test('never for a backgrounded run, and honors the killswitch', () => {
    expect(src).toContain('CLAUDIN_DISABLE_TOOL_REDIRECT')
    expect(src).toContain(
      '!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REDIRECT)',
    )
  })
})
