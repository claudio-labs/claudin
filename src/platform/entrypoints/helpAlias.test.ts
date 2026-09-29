import { describe, expect, test } from 'bun:test'

import { normalizeHelpAlias } from 'src/platform/entrypoints/helpAlias.js'

describe('normalizeHelpAlias', () => {
  test('rewrites a lone -help', () => {
    expect(normalizeHelpAlias(['-help'])).toEqual(['--help'])
  })

  test('rewrites -help after a subcommand path', () => {
    expect(normalizeHelpAlias(['mcp', '-help'])).toEqual(['mcp', '--help'])
    expect(normalizeHelpAlias(['mcp', 'add', '-help'])).toEqual([
      'mcp',
      'add',
      '--help',
    ])
  })

  test('leaves -help alone once an option has been seen', () => {
    // `--system-prompt -help` hands -help to the option as its value, and a
    // bare `-p -help` is not a help request either.
    for (const args of [
      ['--system-prompt', '-help'],
      ['-p', '-help'],
      ['--model', 'x', '-help'],
    ]) {
      expect(normalizeHelpAlias(args)).toBe(args)
    }
  })

  test('returns the same array when there is nothing to rewrite', () => {
    for (const args of [[], ['--help'], ['-h'], ['fix the bug'], ['mcp', 'list']]) {
      expect(normalizeHelpAlias(args)).toBe(args)
    }
  })

  test('does not touch the caller\'s array when it rewrites', () => {
    const args = ['-help']
    normalizeHelpAlias(args)
    expect(args).toEqual(['-help'])
  })

  test('only rewrites the exact token', () => {
    for (const args of [['-helpme'], ['-hel'], ['-Help'], ['---help']]) {
      expect(normalizeHelpAlias(args)).toBe(args)
    }
  })
})
