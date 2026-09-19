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
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  normalizePatternsToPath,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from 'src/permissions/filesystem.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'

type Decision = ReturnType<typeof checkReadPermissionForTool>

// checkWrite/ReadPermissionForTool take a Tool; the only member either one
// touches is getPath (plus name, for the message). Casting through unknown
// keeps the suite free of `any` and free of mock.module, which leaks across
// files in this runner.
type PermissionCheck = (
  tool: unknown,
  input: unknown,
  context: ToolPermissionContext,
) => Decision

const FILE_TOOL = {
  name: 'Edit',
  getPath: (input: { file_path: string }) => input.file_path,
}
const PATHLESS_TOOL = { name: 'Thinking' }

function callWrite(path: string, context: ToolPermissionContext): Decision {
  return (checkWritePermissionForTool as unknown as PermissionCheck)(
    FILE_TOOL,
    { file_path: path },
    context,
  )
}

function callRead(tool: unknown, path: string, ctx: ToolPermissionContext) {
  return (checkReadPermissionForTool as unknown as PermissionCheck)(
    tool,
    { file_path: path },
    ctx,
  )
}

function contextWith(
  overrides: Partial<Record<string, unknown>>,
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    ...overrides,
  } as unknown as ToolPermissionContext
}

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

describe('pathInWorkingPath', () => {
  test('a directory contains itself', () => {
    expect(pathInWorkingPath('/repo/src', '/repo/src')).toBe(true)
  })

  test('a descendant is inside', () => {
    expect(pathInWorkingPath('/repo/src/a/b.ts', '/repo')).toBe(true)
  })

  test('a sibling is outside', () => {
    expect(pathInWorkingPath('/other/a.ts', '/repo')).toBe(false)
  })

  test('a prefix match that is not a path boundary is outside', () => {
    expect(pathInWorkingPath('/repo-evil/a.ts', '/repo')).toBe(false)
  })

  test('a traversal escape is outside', () => {
    expect(pathInWorkingPath('/repo/../etc/passwd', '/repo')).toBe(false)
  })

  test('macOS /private/tmp is normalized onto /tmp', () => {
    expect(pathInWorkingPath('/private/tmp/work/a.ts', '/tmp/work')).toBe(true)
    expect(pathInWorkingPath('/tmp/work/a.ts', '/private/tmp/work')).toBe(true)
  })

  test('comparison is case-insensitive', () => {
    expect(pathInWorkingPath('/Repo/SRC/a.ts', '/repo/src')).toBe(true)
  })
})

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

describe('normalizePatternsToPath', () => {
  test('root-less patterns pass through untouched', () => {
    const result = normalizePatternsToPath(
      new Map([[null, ['*.env', 'secrets/**']]]),
      '/repo',
    )
    expect(result).toEqual(['*.env', 'secrets/**'])
  })

  test('a pattern whose root is the reference root keeps its own path', () => {
    const result = normalizePatternsToPath(
      new Map([['/repo', ['/src/a.ts']]]),
      '/repo',
    )
    expect(result).toEqual(['/src/a.ts'])
  })

  test('a pattern rooted below the reference root is rewritten relative to it', () => {
    const result = normalizePatternsToPath(
      new Map([['/repo/pkg', ['/src/a.ts']]]),
      '/repo',
    )
    expect(result).toEqual(['/pkg/src/a.ts'])
  })

  test('a pattern rooted outside the reference root is dropped', () => {
    const result = normalizePatternsToPath(
      new Map([['/elsewhere', ['/src/a.ts']]]),
      '/repo',
    )
    expect(result).toEqual([])
  })

  test('duplicate results are collapsed', () => {
    const result = normalizePatternsToPath(
      new Map([
        [null, ['/src/a.ts']],
        ['/repo', ['/src/a.ts']],
      ]),
      '/repo',
    )
    expect(result).toEqual(['/src/a.ts'])
  })
})

describe('matchingRuleForInput', () => {
  test('finds the deny rule that covers an absolute path', () => {
    withTempDir(dir => {
      const file = join(dir, 'secret.ts')
      writeFileSync(file, '')
      const ctx = contextWith({
        alwaysDenyRules: { cliArg: [`Edit(/${file})`] },
      })
      const rule = matchingRuleForInput(file, ctx, 'edit', 'deny')
      expect(rule).not.toBeNull()
      expect(rule?.ruleValue.toolName).toBe('Edit')
    })
  })

  test('returns null for a path no rule covers', () => {
    withTempDir(dir => {
      const ctx = contextWith({
        alwaysDenyRules: { cliArg: [`Edit(/${join(dir, 'secret.ts')})`] },
      })
      const other = join(dir, 'public.ts')
      expect(matchingRuleForInput(other, ctx, 'edit', 'deny')).toBeNull()
    })
  })

  test('a /** rule covers files inside the directory', () => {
    withTempDir(dir => {
      const sub = join(dir, 'private')
      mkdirSync(sub)
      const file = join(sub, 'a.ts')
      writeFileSync(file, '')
      const ctx = contextWith({
        alwaysDenyRules: { cliArg: [`Edit(/${sub}/**)`] },
      })
      expect(matchingRuleForInput(file, ctx, 'edit', 'deny')).not.toBeNull()
    })
  })

  test('a /** rule also covers the directory itself', () => {
    withTempDir(dir => {
      // Pins the `/**` suffix stripping: the ignore library treats a bare
      // `private` as the directory AND its contents, while `private/**`
      // matches only the contents.
      const sub = join(dir, 'private')
      mkdirSync(sub)
      const ctx = contextWith({
        alwaysDenyRules: { cliArg: [`Edit(/${sub}/**)`] },
      })
      const rule = matchingRuleForInput(sub, ctx, 'edit', 'deny')
      expect(rule).not.toBeNull()
      // and the matched rule is mapped back to the original /** pattern
      expect(rule?.ruleValue.ruleContent).toBe(`/${sub}/**`)
    })
  })

  test('an edit rule does not answer a read query', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      const ctx = contextWith({
        alwaysDenyRules: { cliArg: [`Edit(/${file})`] },
      })
      expect(matchingRuleForInput(file, ctx, 'read', 'deny')).toBeNull()
    })
  })
})

describe('getFileReadIgnorePatterns', () => {
  test('returns the read-deny patterns keyed by their root', () => {
    const ctx = contextWith({
      alwaysDenyRules: { cliArg: ['Read(secrets/**)', 'Read(*.pem)'] },
    })
    const patterns = getFileReadIgnorePatterns(ctx)
    expect(patterns.get(null)).toEqual(['secrets/**', '*.pem'])
  })

  test('ignores edit-deny rules', () => {
    const ctx = contextWith({
      alwaysDenyRules: { cliArg: ['Edit(secrets/**)'] },
    })
    expect(getFileReadIgnorePatterns(ctx).size).toBe(0)
  })
})

describe('checkWritePermissionForTool', () => {
  test('asks when the tool exposes no path', () => {
    const decision = (
      checkWritePermissionForTool as unknown as PermissionCheck
    )(PATHLESS_TOOL, {}, getEmptyToolPermissionContext())
    expect(decision.behavior).toBe('ask')
  })

  test('denies a path covered by a deny rule, citing the rule', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      const decision = callWrite(
        file,
        workingDirContext(dir, {
          alwaysDenyRules: { cliArg: [`Edit(/${file})`] },
        }),
      )
      expect(decision.behavior).toBe('deny')
      expect(decision.decisionReason?.type).toBe('rule')
    })
  })

  test('asks for a path outside every working directory', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      const decision = callWrite(file, contextWith({ mode: 'default' }))
      expect(decision.behavior).toBe('ask')
    })
  })

  test('allows a path inside a working directory under acceptEdits', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      expect(callWrite(file, workingDirContext(dir)).behavior).toBe('allow')
    })
  })

  test('the deny rule wins over the working directory', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      const decision = callWrite(
        file,
        workingDirContext(dir, {
          alwaysDenyRules: { cliArg: [`Edit(/${file})`] },
        }),
      )
      expect(decision.behavior).toBe('deny')
    })
  })
})

describe('checkReadPermissionForTool', () => {
  test('asks when the tool exposes no path', () => {
    const decision = callRead(
      PATHLESS_TOOL,
      '/repo/a.ts',
      getEmptyToolPermissionContext(),
    )
    expect(decision.behavior).toBe('ask')
    expect(decision.message).toContain('Thinking')
  })

  test('denies a path covered by a Read deny rule', () => {
    withTempDir(dir => {
      const file = join(dir, 'a.ts')
      writeFileSync(file, '')
      const decision = callRead(
        FILE_TOOL,
        file,
        workingDirContext(dir, {
          alwaysDenyRules: { cliArg: [`Read(/${file})`] },
        }),
      )
      expect(decision.behavior).toBe('deny')
    })
  })
})
