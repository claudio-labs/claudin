/**
 * The config syntax the rewrite now reads the way git does (findings F6 to
 * F10 of docs/tech/rewrite/vcs/gitFilesystem.md), through parseGitConfigValue.
 * Each case is also asked of `git config -f <file> --get`, and values git
 * itself writes are read back.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { parseGitConfigValue } from 'src/vcs/git/gitConfigParser.js'

const scratch = new ScratchGit()
afterAll(() => scratch.cleanup())

function configDir(text: string): string {
  const dir = scratch.tempDir('config-fix')
  writeFileSync(join(dir, 'config'), text)
  return dir
}

function gitReads(dir: string, key: string): string | null {
  const outcome = scratch.attempt(dir, 'config', '-f', join(dir, 'config'), '--get', key)
  return outcome.ok ? outcome.stdout : null
}

const CASES: Array<{ finding: string; title: string; text: string; expected: string }> = [
  { finding: 'F6', title: 'an escaped quote outside quotes', text: '[remote "origin"]\n\turl = x\\"y\n', expected: 'x"y' },
  { finding: 'F6', title: 'tab, newline and backspace escapes outside quotes', text: '[remote "origin"]\n\turl = a\\tb\\nc\\bd\n', expected: 'a\tb\nc\bd' },
  { finding: 'F7', title: 'blanks at the end of a quoted part', text: '[remote "origin"]\n\turl = "abc  "\n', expected: 'abc  ' },
  { finding: 'F7', title: 'blanks at the end of a quoted part, then more', text: '[remote "origin"]\n\turl = "a  "b\n', expected: 'a  b' },
  { finding: 'F8', title: 'a continuation line outside quotes', text: '[remote "origin"]\n\turl = abc\\\ndef\n', expected: 'abcdef' },
  { finding: 'F8', title: 'a continuation line inside quotes', text: '[remote "origin"]\n\turl = "abc\\\ndef"\n', expected: 'abcdef' },
  { finding: 'F9', title: 'the old [section.subsection] header', text: '[remote.origin]\n\turl = dotted\n', expected: 'dotted' },
  { finding: 'F9', title: 'the old header, its subsection read in lower case', text: '[remote.ORIGIN]\n\turl = lowered\n', expected: 'lowered' },
  { finding: 'F10', title: "a key on its section's header line", text: '[remote "origin"] url = inline\n', expected: 'inline' },
]

describe('parseGitConfigValue reads these as git does', () => {
  for (const { finding, title, text, expected } of CASES) {
    test(`${finding}: ${title}`, async () => {
      const dir = configDir(text)
      expect(await parseGitConfigValue(dir, 'remote', 'origin', 'url')).toBe(expected)
      expect(gitReads(dir, 'remote.origin.url')).toBe(expected)
    })
  }

  test('F10: a key on a plain section header line', async () => {
    const dir = configDir('[core] hooksPath = /x\n')
    expect(await parseGitConfigValue(dir, 'core', null, 'hooksPath')).toBe('/x')
    expect(gitReads(dir, 'core.hooksPath')).toBe('/x')
  })
})

describe('values written by git read back unchanged', () => {
  test.each([
    'x"y',
    'C:\\hooks\\dir',
    'tab\there',
    'new\nline',
    ' leading blank',
    'trailing blank ',
    'a#b;c',
    '  ',
  ])('%p', async value => {
    const dir = scratch.tempDir('config-written')
    writeFileSync(join(dir, 'config'), '')
    scratch.run(dir, 'config', '-f', join(dir, 'config'), 'remote.origin.url', value)
    expect(gitReads(dir, 'remote.origin.url')).toBe(value)
    expect(await parseGitConfigValue(dir, 'remote', 'origin', 'url')).toBe(value)
  })
})

describe('F6, beyond git: an unknown escape outside quotes', () => {
  test('stands for its character, as inside quotes, where git refuses the file', async () => {
    const dir = configDir('[remote "origin"]\n\turl = a\\qb\n')
    expect(await parseGitConfigValue(dir, 'remote', 'origin', 'url')).toBe('aqb')
    expect(scratch.attempt(dir, 'config', '-f', join(dir, 'config'), '--get', 'remote.origin.url').code).toBe(128)
  })
})
