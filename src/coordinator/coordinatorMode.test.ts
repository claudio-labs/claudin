/**
 * Regression tests for `getCoordinatorUserContext` — MCP server names
 * must be sorted to keep the coordinator user-context byte-stable across
 * turns, otherwise async MCP-connect ordering bleeds into the prompt
 * prefix and breaks the cache.
 *
 * `isCoordinatorMode()` early-returns false when its build-time feature
 * flag (COORDINATOR_MODE) resolves to false, which is the case under
 * raw `bun test` (bun:bundle is resolved natively by the bundler at
 * build time, not at test time). So we cannot exercise the branch that
 * builds the user-context string; instead we assert the source pattern
 * documenting the bug. After the fix, the assertion below should flip.
 */
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudinlabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { getCoordinatorUserContext } from './coordinatorMode.ts'

describe('getCoordinatorUserContext', () => {
  test('returns {} when coordinator mode is off (default in tests)', () => {
    expect(getCoordinatorUserContext([{ name: 'a' }, { name: 'b' }])).toEqual({})
  })

  test('CURRENT BUG: MCP server names are joined in input order without sort', () => {
    // Document the bug at the source level. After the fix this should
    // be `expect(src).toMatch(/mcpClients[\s\S]*\.sort\(/)`.
    const src = readFileSync(
      fileURLToPath(new URL('./coordinatorMode.ts', import.meta.url)),
      'utf8',
    )
    // Find the line that builds the MCP server names join.
    const m = src.match(/serverNames\s*=\s*mcpClients\.map\(c\s*=>\s*c\.name\)([^\n]*)/)
    expect(m).not.toBeNull()
    const tail = m![1]!
    // Bug: tail goes straight to .join(...) with no .sort() in between.
    expect(tail).not.toContain('.sort(')
    expect(tail).toContain('.join(')
  })
})
