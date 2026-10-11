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
  ISSUES_EXPLAINER: 'report the issue at https://github.com/claudio-labs/claudin/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import {
  getCoordinatorSystemPrompt,
  getCoordinatorUserContext,
  listWorkerTools,
  matchSessionMode,
} from 'src/agent/coordinator/coordinatorMode.ts'

describe('listWorkerTools — what a coordinator is told its workers hold', () => {
  test('only the tools this build assembled, so a killswitched one is not advertised', () => {
    // WaitFor killswitched (CLAUDIN_DISABLE_WAITFOR_TOOL), PowerShell absent on Linux.
    const listed = listWorkerTools(new Set(['Bash', 'Read', 'Edit', 'Grep', 'Git'])).split(', ')
    expect(listed).toContain('Git')
    expect(listed).not.toContain('WaitFor')
    expect(listed).not.toContain('PowerShell')
  })

  test('never the internal ones, and in a stable order', () => {
    const listed = listWorkerTools(new Set(['SendMessage', 'StructuredOutput', 'Read', 'Bash', 'Grep']))
    expect(listed).toBe('Bash, Grep, Read')
  })

  test('the coordinator context asks the tool registry, not the allowlist alone', () => {
    // The branch that renders it is behind COORDINATOR_MODE, false under bun test.
    const src = readFileSync(fileURLToPath(new URL('./coordinatorMode.ts', import.meta.url)), 'utf8')
    expect(src).toContain(': listWorkerTools(new Set(getToolsForDefaultPreset()))')
  })
})

describe('matchSessionMode — a resumed session takes the mode it was saved in', () => {
  // isCoordinatorMode() is false under bun test, so "current" is always normal.
  const saved = process.env.CLAUDIN_COORDINATOR_MODE
  const restore = () => {
    if (saved === undefined) delete process.env.CLAUDIN_COORDINATOR_MODE
    else process.env.CLAUDIN_COORDINATOR_MODE = saved
  }

  test('a session saved before mode tracking changes nothing', () => {
    expect(matchSessionMode(undefined)).toBeUndefined()
  })

  test('a normal session in normal mode changes nothing', () => {
    expect(matchSessionMode('normal')).toBeUndefined()
  })

  test('a coordinator session flips the switch and says so', () => {
    try {
      delete process.env.CLAUDIN_COORDINATOR_MODE
      expect(matchSessionMode('coordinator')).toBe('Entered coordinator mode to match resumed session.')
      // String(): tsc narrows the variable to undefined after the delete above.
      expect(String(process.env.CLAUDIN_COORDINATOR_MODE)).toBe('1')
    } finally {
      restore()
    }
  })
})

describe('getCoordinatorSystemPrompt', () => {
  test('casts the main thread as the coordinator and names its own tools', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('You are a **coordinator**.')
    expect(prompt).toContain('- **Agent** - Spawn a new worker')
    expect(prompt).toContain('Workers have access to standard tools')
  })

  test('in bare mode it tells the coordinator the workers have only Bash, Read and Edit', () => {
    const saved = process.env.CLAUDIN_SIMPLE
    try {
      process.env.CLAUDIN_SIMPLE = '1'
      expect(getCoordinatorSystemPrompt()).toContain('Workers have access to Bash, Read, and Edit tools')
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_SIMPLE
      else process.env.CLAUDIN_SIMPLE = saved
    }
  })
})

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
