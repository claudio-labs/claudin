/**
 * Characterization of the git config syntax
 * (src/vcs/git/gitConfigParser/configSyntax.ts), through findConfigValue
 * over a config file's text, the way the origin lookup reads it.
 *
 * Every case writes a config file, asks the module, and asks
 * `git config -f <file> --get` the same question. The first table holds what
 * both read alike. The second holds where the module parts from git and keeps
 * doing so on purpose; there the test also records what git answers.
 *
 * Differences the rewrite fixes are deliberately absent: escapes outside
 * quotes, continuation lines, blanks at the end of a quoted part, the dotted
 * [section.subsection] header, and a key on its section's header line.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { findConfigValue } from 'src/vcs/git/gitConfigParser/configSyntax.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

type Question = { section: string; subsection: string | null; key: string }

type GitReading =
  | { kind: 'value'; value: string }
  | { kind: 'absent' }
  | { kind: 'refused' }

function ask(section: string, subsection: string | null, key: string): Question {
  return { section, subsection, key }
}

const ORIGIN_URL = ask('remote', 'origin', 'url')

function underOrigin(...lines: string[]): string {
  return `[remote "origin"]\n${lines.map(line => `\t${line}\n`).join('')}`
}

/** git's spelling of the same key: section.key or section.subsection.key */
function keyForGit(question: Question): string {
  const middle = question.subsection === null ? '' : `.${question.subsection}`
  return `${question.section}${middle}.${question.key}`
}

function readWithGit(dir: string, question: Question): GitReading {
  const outcome = scratch.attempt(dir, 'config', '-f', join(dir, 'config'), '--get', keyForGit(question))
  if (outcome.ok) return { kind: 'value', value: outcome.stdout }
  return outcome.code === 1 ? { kind: 'absent' } : { kind: 'refused' }
}

function configDir(text: string): string {
  const dir = scratch.tempDir('config')
  writeFileSync(join(dir, 'config'), text)
  return dir
}

async function readWithModule(dir: string, question: Question): Promise<string | null> {
  return findConfigValue(readFileSync(join(dir, 'config'), 'utf8'), question)
}

type Agreement = {
  title: string
  text: string
  question: Question
  /** What both the module and git answer; null is "no such key". */
  expected: string | null
  /** Recent git reads this the same way, older git did not, so git is not asked. */
  newerGitOnly?: boolean
}

const AGREEMENTS: Agreement[] = [
  { title: 'a plain value', text: underOrigin('url = https://example.com/r.git'), question: ORIGIN_URL, expected: 'https://example.com/r.git' },
  { title: 'section names ignore case', text: '[REMOTE "origin"]\n\turl = x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'key names ignore case', text: underOrigin('URL = x'), question: ORIGIN_URL, expected: 'x' },
  { title: 'the section and key asked for ignore case too', text: underOrigin('url = x'), question: ask('Remote', 'origin', 'Url'), expected: 'x' },
  { title: 'subsection names are case-sensitive', text: '[remote "Origin"]\n\turl = x\n', question: ORIGIN_URL, expected: null },
  { title: 'a subsection matches in its own case', text: '[remote "Origin"]\n\turl = x\n', question: ask('remote', 'Origin', 'url'), expected: 'x' },
  { title: 'an escaped quote and backslash in a subsection name', text: '[remote "a\\"b\\\\c"]\n\turl = x\n', question: ask('remote', 'a"b\\c', 'url'), expected: 'x' },
  { title: 'any other escaped character in a subsection name stands for itself', text: '[remote "a\\xb"]\n\turl = x\n', question: ask('remote', 'axb', 'url'), expected: 'x' },
  { title: 'a subsection name may hold ]', text: '[remote "a]b"]\n\turl = x\n', question: ask('remote', 'a]b', 'url'), expected: 'x' },
  { title: 'blanks and tabs between section and subsection', text: '[remote \t "origin"]\n\turl = x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'an empty subsection is still a subsection', text: '[remote ""]\n\turl = e\n', question: ask('remote', '', 'url'), expected: 'e' },
  { title: 'a question with a subsection skips a plain section', text: '[remote]\n\turl = a\n', question: ORIGIN_URL, expected: null },
  { title: 'a question without a subsection skips sections that have one', text: '[core "x"]\n\thooksPath = /a\n[core]\n\thooksPath = /b\n', question: ask('core', null, 'hooksPath'), expected: '/b' },
  { title: 'a section matches on its whole name', text: '[remotes "origin"]\n\turl = a\n', question: ORIGIN_URL, expected: null },
  { title: 'dashes in section and key names', text: '[my-section]\n\tsome-key = v\n', question: ask('my-section', null, 'some-key'), expected: 'v' },
  { title: 'blanks before a section header', text: '   [remote "origin"]\n\turl = x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'a comment after a section header', text: '[remote "origin"] # note\n\turl = x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'a key counts only inside its own section', text: '[remote "origin"]\n\tfetch = f\n[remote "up"]\n\turl = u\n', question: ORIGIN_URL, expected: null },
  { title: 'comment lines and blank lines are skipped', text: '# top\n; also\n\n[remote "origin"]\n\t# url = no\n\t; url = no\n\n\turl = yes\n', question: ORIGIN_URL, expected: 'yes' },
  { title: 'blanks and tabs around =', text: underOrigin('url\t = \tx'), question: ORIGIN_URL, expected: 'x' },
  { title: 'no blanks around =', text: '[remote "origin"]\nurl=x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'the value may contain =', text: underOrigin('url = a=b'), question: ORIGIN_URL, expected: 'a=b' },
  { title: 'quotes keep the blanks inside them', text: underOrigin('url = "a  b"'), question: ORIGIN_URL, expected: 'a  b' },
  { title: 'quotes may cover part of the value', text: underOrigin('url = a" b "c'), question: ORIGIN_URL, expected: 'a b c' },
  { title: '# starts a comment', text: underOrigin('url = x # note'), question: ORIGIN_URL, expected: 'x' },
  { title: '; starts a comment', text: underOrigin('url = x ; note'), question: ORIGIN_URL, expected: 'x' },
  { title: 'a comment needs no blank before it', text: underOrigin('url = a#b'), question: ORIGIN_URL, expected: 'a' },
  { title: '# and ; inside quotes are text', text: underOrigin('url = "x # y ; z"'), question: ORIGIN_URL, expected: 'x # y ; z' },
  { title: 'a quoted value followed by a comment', text: underOrigin('url = "a" # note'), question: ORIGIN_URL, expected: 'a' },
  { title: 'escapes inside quotes: \\t \\n \\b \\" and \\\\', text: underOrigin('url = "a\\tb\\nc\\\\d\\"e\\bf"'), question: ORIGIN_URL, expected: 'a\tb\nc\\d"e\bf' },
  { title: 'an escaped backslash outside quotes', text: underOrigin('url = C:\\\\x'), question: ORIGIN_URL, expected: 'C:\\x' },
  { title: 'blanks at the end are dropped', text: underOrigin('url = abc   '), question: ORIGIN_URL, expected: 'abc' },
  { title: 'blanks at the start are dropped', text: underOrigin('url =    abc'), question: ORIGIN_URL, expected: 'abc' },
  { title: 'runs of spaces inside are kept', text: underOrigin('url = a   b'), question: ORIGIN_URL, expected: 'a   b' },
  { title: 'nothing after =: the empty string', text: underOrigin('url ='), question: ORIGIN_URL, expected: '' },
  { title: 'an empty quoted value', text: underOrigin('url = ""'), question: ORIGIN_URL, expected: '' },
  { title: 'only blanks after =', text: underOrigin('url =    '), question: ORIGIN_URL, expected: '' },
  { title: 'only a comment after =', text: underOrigin('url = # note'), question: ORIGIN_URL, expected: '' },
  { title: 'CRLF line ends', text: '[remote "origin"]\r\n\turl = x\r\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'a UTF-8 byte order mark', text: '\uFEFF[remote "origin"]\n\turl = x\n', question: ORIGIN_URL, expected: 'x' },
  { title: 'no newline at the end of the file', text: '[remote "origin"]\n\turl = x', question: ORIGIN_URL, expected: 'x' },
  { title: 'a lone CR inside a value is kept', text: underOrigin('url = a\rb'), question: ORIGIN_URL, expected: 'a\rb' },
  { title: 'a key without = gives way to a later assignment of it', text: '[core]\n\thooksPath\n\thooksPath = /x\n', question: ask('core', null, 'hooksPath'), expected: '/x' },
  { title: 'tabs inside a value are kept', text: underOrigin('url = a\t\tb'), question: ORIGIN_URL, expected: 'a\t\tb', newerGitOnly: true },
]

type Departure = {
  title: string
  text: string
  question: Question
  /** What the module answers. */
  expected: string | null
  /** What git answers instead. */
  git: GitReading
}

const DEPARTURES: Departure[] = [
  { title: 'a key set twice: the first value, where git config --get takes the last', text: underOrigin('url = a', 'url = b'), question: ORIGIN_URL, expected: 'a', git: { kind: 'value', value: 'b' } },
  { title: 'a section repeated further down: its first block wins, where git takes the last', text: '[remote "origin"]\n\turl = a\n[core]\n\tbare = false\n[remote "origin"]\n\turl = b\n', question: ORIGIN_URL, expected: 'a', git: { kind: 'value', value: 'b' } },
  { title: 'a key written without =, and nothing later: null, where git has it with no value', text: '[core]\n\tbare\n', question: ask('core', null, 'bare'), expected: null, git: { kind: 'value', value: '' } },
  { title: 'lines git rejects are skipped, and the search goes on', text: underOrigin('!!!', 'my_key = x', 'url x = y', 'url = z'), question: ORIGIN_URL, expected: 'z', git: { kind: 'refused' } },
  { title: 'a quote left open runs to the end of the line', text: underOrigin('url = "abc'), question: ORIGIN_URL, expected: 'abc', git: { kind: 'refused' } },
  { title: 'an unknown escape inside quotes stands for its character', text: underOrigin('url = "a\\qb"'), question: ORIGIN_URL, expected: 'aqb', git: { kind: 'refused' } },
  { title: 'a header with text after the subsection matches nothing', text: '[remote "origin"x]\n\turl = a\n', question: ORIGIN_URL, expected: null, git: { kind: 'refused' } },
  { title: 'a header whose subsection quote is never closed matches nothing', text: '[remote "origin]\n\turl = a\n', question: ORIGIN_URL, expected: null, git: { kind: 'refused' } },
]

describe('findConfigValue: read the same way as git config', () => {
  for (const agreement of AGREEMENTS) {
    test(agreement.title, async () => {
      const dir = configDir(agreement.text)
      expect(await readWithModule(dir, agreement.question)).toBe(agreement.expected)
      if (agreement.newerGitOnly) return
      const byGit = readWithGit(dir, agreement.question)
      expect(byGit).toEqual(
        agreement.expected === null ? { kind: 'absent' } : { kind: 'value', value: agreement.expected },
      )
    })
  }
})

describe('findConfigValue: where it parts from git, on purpose', () => {
  for (const departure of DEPARTURES) {
    test(departure.title, async () => {
      const dir = configDir(departure.text)
      expect(await readWithModule(dir, departure.question)).toBe(departure.expected)
      expect(readWithGit(dir, departure.question)).toEqual(departure.git)
    })
  }
})

describe('findConfigValue: a whole config', () => {
  test('a config written by git 2.55.0 (fixture): every key reads as git reads it', async () => {
    const dir = scratch.tempDir('fixture-config')
    copyFileSync(join(import.meta.dir, '__fixtures__', 'rewrite', 'config'), join(dir, 'config'))
    const expectations: Array<[Question, string | null]> = [
      [ORIGIN_URL, 'https://github.com/example/project.git'],
      [ask('remote', 'origin', 'fetch'), '+refs/heads/*:refs/remotes/origin/*'],
      [ask('remote', 'origin', 'pushurl'), 'ssh://git@example.com/a b#c.git'],
      [ask('core', null, 'hooksPath'), 'C:\\hooks dir\\x'],
      [ask('core', null, 'bare'), 'false'],
      [ask('branch', 'main', 'merge'), 'refs/heads/main'],
      [ask('remote', 'we"ird', 'url'), 'https://example.com/weird.git'],
      [ask('remote', 'Upper', 'url'), 'https://example.com/upper.git'],
      [ask('remote', 'upper', 'url'), null],
      [ask('remote', 'origin', 'mirror'), null],
    ]
    for (const [question, expected] of expectations) {
      expect(await readWithModule(dir, question)).toBe(expected)
      expect(readWithGit(dir, question)).toEqual(
        expected === null ? { kind: 'absent' } : { kind: 'value', value: expected },
      )
    }
  })
})
