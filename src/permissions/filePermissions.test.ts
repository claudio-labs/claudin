/**
 * Characterization suite for the permission-owned half of filesystem.ts.
 *
 * Written before the module is split into a barrel over
 * `src/permissions/filePermissions/`, so that an extraction that moves a body
 * into the wrong sibling — or drops a re-export — fails here rather than in
 * production. It deliberately covers ONLY the symbols that stay in the
 * permissions slice; the path helpers that belong to memory/, skills/, agent/
 * and the host are moving out and are pinned by their new owners instead.
 *
 * Every assertion was checked by breaking the line it guards and watching it
 * go red before being committed.
 *
 * The rule-pattern and read/write check cases moved to the `permissions/fileRules`
 * characterization suites beside the module (`filePermissions/*.characterization.test.ts`).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  allWorkingDirectories,
  checkPathSafetyForAutoEdit,
  pathInAllowedWorkingPath,
} from 'src/permissions/filePermissions.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'

const contextWith = (overrides: Partial<Record<string, unknown>>) =>
  Object.assign(getEmptyToolPermissionContext(), overrides) as unknown as ToolPermissionContext

function workingDirContext(
  dir: string,
  overrides: Partial<Record<string, unknown>> = {},
): ToolPermissionContext {
  return contextWith({
    mode: 'acceptEdits',
    additionalWorkingDirectories: new Map([[dir, { source: 'cli' }]]),
    ...overrides,
  })
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fs-perm-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('allWorkingDirectories', () => {
  test('always includes the original cwd', () => {
    const dirs = allWorkingDirectories(getEmptyToolPermissionContext())
    expect(dirs.has(getOriginalCwd())).toBe(true)
  })

  test('includes every additional working directory', () => {
    const dirs = allWorkingDirectories(
      contextWith({
        additionalWorkingDirectories: new Map([
          ['/extra/one', { source: 'cli' }],
          ['/extra/two', { source: 'cli' }],
        ]),
      }),
    )
    expect(dirs.has('/extra/one')).toBe(true)
    expect(dirs.has('/extra/two')).toBe(true)
    expect(dirs.has(getOriginalCwd())).toBe(true)
  })
})

describe('pathInAllowedWorkingPath', () => {
  test('accepts a file inside an additional working directory', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      expect(pathInAllowedWorkingPath(file, workingDirContext(dir))).toBe(true)
    })
  })

  test('rejects a file outside every working directory', () => {
    withTempDir(dir => {
      const allowed = join(dir, 'allowed')
      const outside = join(dir, 'outside')
      mkdirSync(allowed)
      mkdirSync(outside)
      const file = join(outside, 'a.ts')
      writeFileSync(file, '')
      expect(pathInAllowedWorkingPath(file, workingDirContext(allowed))).toBe(
        false,
      )
    })
  })
})

describe('checkPathSafetyForAutoEdit', () => {
  test('an ordinary source file is safe', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      expect(checkPathSafetyForAutoEdit(file).safe).toBe(true)
    })
  })

  test('a path inside .git is unsafe and classifier-approvable', () => {
    withTempDir(dir => {
      const result = checkPathSafetyForAutoEdit(join(dir, '.git', 'config'))
      expect(result.safe).toBe(false)
      if (!result.safe) {
        expect(result.classifierApprovable).toBe(true)
        expect(result.message).toContain('sensitive file')
      }
    })
  })

  test('the dangerous-directory check is case-insensitive', () => {
    withTempDir(dir => {
      // Pins normalizeCaseForComparison: without it, .GiT slips past the
      // segment comparison on a case-insensitive filesystem.
      expect(checkPathSafetyForAutoEdit(join(dir, '.GiT', 'config')).safe).toBe(
        false,
      )
      expect(
        checkPathSafetyForAutoEdit(join(dir, '.VSCode', 'tasks.json')).safe,
      ).toBe(false)
    })
  })

  test('a dangerous file name is unsafe wherever it sits', () => {
    withTempDir(dir => {
      expect(checkPathSafetyForAutoEdit(join(dir, '.bashrc')).safe).toBe(false)
      expect(checkPathSafetyForAutoEdit(join(dir, '.gitconfig')).safe).toBe(
        false,
      )
      expect(checkPathSafetyForAutoEdit(join(dir, '.mcp.json')).safe).toBe(
        false,
      )
    })
  })

  test('a UNC-style path is unsafe', () => {
    expect(checkPathSafetyForAutoEdit('//server/share/a.ts').safe).toBe(false)
    expect(checkPathSafetyForAutoEdit('\\\\server\\share\\a.ts').safe).toBe(
      false,
    )
  })

  test('a file under .claudin/worktrees is not treated as a dangerous dir', () => {
    withTempDir(dir => {
      const inWorktree = join(
        dir,
        '.claudin',
        'worktrees',
        'agent-1',
        'src',
        'a.ts',
      )
      expect(checkPathSafetyForAutoEdit(inWorktree).safe).toBe(true)
    })
  })

  test('a nested .claudin inside a worktree is still dangerous', () => {
    withTempDir(dir => {
      const nested = join(
        dir,
        '.claudin',
        'worktrees',
        'agent-1',
        '.claudin',
        'settings.json',
      )
      expect(checkPathSafetyForAutoEdit(nested).safe).toBe(false)
    })
  })
})
