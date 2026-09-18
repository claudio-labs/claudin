import { describe, expect, test } from 'bun:test'
import {
  getCommandPrefixStatic,
  getCompoundCommandPrefixesStatic,
} from 'src/platform/bash/prefix.js'

/**
 * These feed the editable "Yes, and don't ask again for: ___" field in the Bash
 * permission dialog (`BashPermissionRequest.tsx`). Every one of them returned
 * null or [] before this file existed, because the extractor asked the
 * tree-sitter parser for argv and that parser returns null in every shipped
 * bundle — so the field came up empty and the user had to type the rule.
 *
 * The exact strings are whatever the fig-spec walker (`shell/specPrefix.ts`)
 * decides from `registry.ts`; what is pinned here is that a prefix comes back at
 * all, that it is a real prefix of the command, and that the compound collapse
 * groups by root command.
 */
describe('getCommandPrefixStatic', () => {
  test('extracts a subcommand-aware prefix', async () => {
    const result = await getCommandPrefixStatic('git status --short')
    expect(result?.commandPrefix).toBe('git status')
  })

  test('keeps a leading environment assignment in the prefix', async () => {
    const result = await getCommandPrefixStatic('FOO=bar git status')
    expect(result?.commandPrefix).toBe('FOO=bar git status')
  })

  test('returns a null prefix for an empty command rather than throwing', async () => {
    expect((await getCommandPrefixStatic(''))?.commandPrefix).toBeNull()
  })
})

describe('getCompoundCommandPrefixesStatic', () => {
  test('returns one prefix per root command', async () => {
    const prefixes = await getCompoundCommandPrefixesStatic(
      'git status && git diff',
    )
    // Both arms share the `git` root, so the word-aligned LCP collapses them.
    expect(prefixes).toEqual(['git'])
  })

  test('keeps distinct roots apart', async () => {
    const prefixes = await getCompoundCommandPrefixesStatic(
      'git status && npm run build',
    )
    expect(prefixes.length).toBe(2)
    expect(prefixes.some(p => p.startsWith('git'))).toBe(true)
    expect(prefixes.some(p => p.startsWith('npm'))).toBe(true)
  })

  test('honours the exclude filter', async () => {
    const prefixes = await getCompoundCommandPrefixesStatic(
      'git status && npm run build',
      sub => sub.startsWith('git'),
    )
    expect(prefixes.every(p => !p.startsWith('git'))).toBe(true)
  })

  test('a single command still yields its prefix', async () => {
    const prefixes = await getCompoundCommandPrefixesStatic('git status')
    expect(prefixes).toEqual(['git status'])
  })
})
