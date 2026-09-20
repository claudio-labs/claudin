/**
 * The --allowed-tools / --disallowed-tools / --base-tools CLI surface.
 *
 * Pure string parsing. The thing worth pinning is the parenthesis depth rule:
 * a comma or a space INSIDE `Tool(...)` belongs to the rule content, and a
 * splitter that forgets that turns `Bash(git add, git commit)` into two
 * half-rules, one of which (`Bash(git add`) never matches anything.
 */
import { describe, expect, test } from 'bun:test'
import {
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
} from 'src/permissions/permissionSetup.js'

describe('parseToolListFromCLI', () => {
  test('an empty invocation yields no tools', () => {
    expect(parseToolListFromCLI([])).toEqual([])
    expect(parseToolListFromCLI([''])).toEqual([])
  })

  test('one comma-separated flag', () => {
    expect(parseToolListFromCLI(['Bash,Read'])).toEqual(['Bash', 'Read'])
  })

  test('repeated flags accumulate', () => {
    expect(parseToolListFromCLI(['Bash', 'Read'])).toEqual(['Bash', 'Read'])
  })

  test('comma and repeated flags mix', () => {
    expect(parseToolListFromCLI(['Bash,Read', 'Glob'])).toEqual([
      'Bash',
      'Read',
      'Glob',
    ])
  })

  test('a space also separates tools', () => {
    expect(parseToolListFromCLI(['Bash Read'])).toEqual(['Bash', 'Read'])
  })

  test('surrounding whitespace is trimmed off each entry', () => {
    expect(parseToolListFromCLI([' Bash , Read '])).toEqual(['Bash', 'Read'])
  })

  test('an empty entry between separators is dropped', () => {
    expect(parseToolListFromCLI(['Bash,,Read'])).toEqual(['Bash', 'Read'])
    expect(parseToolListFromCLI(['Bash,', ''])).toEqual(['Bash'])
  })

  test('a comma inside parentheses stays in the rule content', () => {
    expect(parseToolListFromCLI(['Bash(git add, git commit)'])).toEqual([
      'Bash(git add, git commit)',
    ])
  })

  test('a space inside parentheses stays in the rule content', () => {
    expect(parseToolListFromCLI(['Bash(npm run build)'])).toEqual([
      'Bash(npm run build)',
    ])
  })

  test('a parenthesised rule still separates from the next tool', () => {
    expect(parseToolListFromCLI(['Bash(git add:*),Read'])).toEqual([
      'Bash(git add:*)',
      'Read',
    ])
    expect(parseToolListFromCLI(['Bash(git add:*) Read'])).toEqual([
      'Bash(git add:*)',
      'Read',
    ])
  })

  test('an unknown tool name is passed through, not filtered', () => {
    // Validation happens later, against the live registry; dropping it here
    // would silently swallow a typo instead of reporting it.
    expect(parseToolListFromCLI(['Frobnicate,Bash'])).toEqual([
      'Frobnicate',
      'Bash',
    ])
  })

  test('an unterminated parenthesis keeps the rest as one entry', () => {
    expect(parseToolListFromCLI(['Bash(git add,Read'])).toEqual([
      'Bash(git add,Read',
    ])
  })
})

describe('parseBaseToolsFromCLI', () => {
  test('a preset name expands to the default tool set', () => {
    const tools = parseBaseToolsFromCLI(['default'])
    expect(tools.length).toBeGreaterThan(1)
    expect(tools).toContain('Bash')
    expect(tools).not.toContain('default')
  })

  test('preset matching is case-insensitive', () => {
    expect(parseBaseToolsFromCLI(['DEFAULT'])).toEqual(
      parseBaseToolsFromCLI(['default']),
    )
  })

  test('a custom list is parsed as a tool list, not as a preset', () => {
    expect(parseBaseToolsFromCLI(['Bash,Read'])).toEqual(['Bash', 'Read'])
  })

  test('the elements are joined before the preset check', () => {
    // `--base-tools default` arrives as one element, but an argv split can
    // deliver several; joining is what keeps both spellings equivalent.
    expect(parseBaseToolsFromCLI(['default', ''])).toEqual(
      parseBaseToolsFromCLI(['default']),
    )
  })

  test('a tool whose name contains a preset word is still a custom list', () => {
    expect(parseBaseToolsFromCLI(['Bash,default'])).toEqual([
      'Bash',
      'default',
    ])
  })
})
