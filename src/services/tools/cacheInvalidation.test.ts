import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'

import { APPLY_PATCH_TOOL_NAME } from '../../tools/ApplyPatchTool/prompt.js'
import { resolveApplyPatchPaths } from '../../tools/ApplyPatchTool/applyPatch.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../../tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../../tools/ExitWorktreeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/toolName.js'
import { invalidateCacheForWrite } from './cacheInvalidation.js'
import { __resetForTests, getCached, setCached } from './toolResultCache.js'

beforeEach(() => __resetForTests())
afterEach(() => __resetForTests())

describe('invalidateCacheForWrite (write → read-cache wiring)', () => {
  test('apply_patch drops searches for every patched path (relative + absolute keyed)', () => {
    // Drives the real dispatch (NOT the helper inline), so deleting the
    // apply_patch branch in invalidateCacheForWrite fails this test.
    const patchText =
      '*** Begin Patch\n*** Update File: rel/foo.ts\n@@\n-a\n+b\n*** End Patch'
    const absDir = dirname(resolveApplyPatchPaths({ patchText })[0])
    setCached('Grep', { pattern: 'x', path: 'rel' }, { n: 1 })
    setCached('Grep', { pattern: 'y', path: absDir }, { n: 2 })

    invalidateCacheForWrite(APPLY_PATCH_TOOL_NAME, { patchText })

    expect(getCached('Grep', { pattern: 'x', path: 'rel' })).toBeUndefined()
    expect(getCached('Grep', { pattern: 'y', path: absDir })).toBeUndefined()
  })

  test('apply_patch with a non-string patchText is a no-op (no throw)', () => {
    setCached('Grep', { pattern: 'x' }, { n: 1 })
    invalidateCacheForWrite(APPLY_PATCH_TOOL_NAME, { patchText: 123 })
    expect(getCached('Grep', { pattern: 'x' })?.data).toEqual({ n: 1 })
  })

  test('Edit invalidates the cache by file_path', () => {
    setCached('Glob', { pattern: '**/*.ts', path: '/proj/src' }, { n: 3 })
    invalidateCacheForWrite(FILE_EDIT_TOOL_NAME, { file_path: '/proj/src/a.ts' })
    expect(getCached('Glob', { pattern: '**/*.ts', path: '/proj/src' })).toBeUndefined()
  })

  test('Bash clears the entire cache', () => {
    setCached('Grep', { pattern: 'x' }, { n: 1 })
    setCached('Glob', { pattern: 'y' }, { n: 2 })
    invalidateCacheForWrite(BASH_TOOL_NAME, {})
    expect(getCached('Grep', { pattern: 'x' })).toBeUndefined()
    expect(getCached('Glob', { pattern: 'y' })).toBeUndefined()
  })

  test('Monitor clears the entire cache (runs the same shell exec as Bash)', () => {
    setCached('Grep', { pattern: 'x' }, { n: 1 })
    setCached('Glob', { pattern: 'y' }, { n: 2 })
    invalidateCacheForWrite(MONITOR_TOOL_NAME, { command: 'npm run build' })
    expect(getCached('Grep', { pattern: 'x' })).toBeUndefined()
    expect(getCached('Glob', { pattern: 'y' })).toBeUndefined()
  })

  test('EnterWorktree clears the entire cache (process.chdir repoints relative paths)', () => {
    // A relative-path entry keyed before the chdir would resolve against the
    // worktree dir afterwards — must not survive the switch.
    setCached('Grep', { pattern: 'x', path: 'src' }, { n: 1 })
    setCached('Read', { file_path: 'README.md' }, { n: 2 })
    invalidateCacheForWrite(ENTER_WORKTREE_TOOL_NAME, { name: 'feat/x' })
    expect(getCached('Grep', { pattern: 'x', path: 'src' })).toBeUndefined()
    expect(getCached('Read', { file_path: 'README.md' })).toBeUndefined()
  })

  test('ExitWorktree clears the entire cache (process.chdir back to main repo)', () => {
    setCached('Glob', { pattern: '**/*.ts', path: 'src' }, { n: 1 })
    invalidateCacheForWrite(EXIT_WORKTREE_TOOL_NAME, {})
    expect(getCached('Glob', { pattern: '**/*.ts', path: 'src' })).toBeUndefined()
  })

  test('a non-write tool name leaves the cache untouched', () => {
    setCached('Grep', { pattern: 'x' }, { n: 1 })
    invalidateCacheForWrite('Read', { file_path: '/whatever' })
    expect(getCached('Grep', { pattern: 'x' })?.data).toEqual({ n: 1 })
  })
})
