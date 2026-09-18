import { describe, expect, test } from 'bun:test'
import { RegexParsedCommand_DEPRECATED } from 'src/platform/bash/ParsedCommand.js'

// The regex implementation is the only one `ParsedCommand.parse` has ever
// returned — the tree-sitter sibling needs a parser module that no shipped
// bundle loads. It had no direct test. Nothing here touches
// `getTreeSitterAnalysis`, deliberately: that member goes away with the AST
// layer, and a pin written against it would turn red on the removal it exists
// to guard.
describe('RegexParsedCommand_DEPRECATED', () => {
  test('keeps the original command verbatim', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('git status')
    expect(parsed.originalCommand).toBe('git status')
    expect(parsed.toString()).toBe('git status')
  })

  test('splits a pipeline into its segments', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('cat a.txt | grep foo')
    expect(parsed.getPipeSegments()).toEqual(['cat a.txt', 'grep foo'])
  })

  test('a command with no pipe is a single segment', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('git status')
    expect(parsed.getPipeSegments()).toEqual(['git status'])
  })

  test('reports an output redirection and its operator', () => {
    expect(
      new RegexParsedCommand_DEPRECATED('echo hi > out.txt').
        getOutputRedirections(),
    ).toEqual([{ target: 'out.txt', operator: '>' }])
    expect(
      new RegexParsedCommand_DEPRECATED('echo hi >> log.txt').
        getOutputRedirections(),
    ).toEqual([{ target: 'log.txt', operator: '>>' }])
  })

  test('strips the redirection from the command it reports', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('echo hi > out.txt')
    expect(parsed.withoutOutputRedirections()).toBe('echo hi')
  })

  test('a command with no redirection at all is returned untouched', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('git status')
    expect(parsed.withoutOutputRedirections()).toBe('git status')
  })

  // A `>` inside quotes is not a redirect. This pins the fallback at
  // ParsedCommand.ts:86-88 — when the extractor finds no redirection, the
  // ORIGINAL string is returned rather than its reconstruction, which would
  // otherwise silently rewrite the user's quoting.
  test('a quoted angle bracket is not treated as a redirection', () => {
    const parsed = new RegexParsedCommand_DEPRECATED('git commit -m "a > b"')
    expect(parsed.getOutputRedirections()).toEqual([])
    expect(parsed.withoutOutputRedirections()).toBe('git commit -m "a > b"')
  })
})
