/**
 * Tests for checkBatchReadPermission — the aggregated read-permission decision
 * across the files of a batch Read (`file_paths`). Mirrors
 * checkBatchWritePermission.test.ts, plus the two properties a read batch has
 * that the write batch does not: a rule-backed ask keeps its rule, and no
 * bypassPermissions shortcut reaches past a deny.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkBatchReadPermission } from 'src/permissions/filePermissions/readWriteChecks.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

// A path outside the working directories reaches checkReadableInternalPath,
// which reads the build-time MACRO.VERSION (bundled-skills root). Put back
// whatever an earlier file left there.
let priorMacro: unknown
beforeAll(() => {
  priorMacro = (globalThis as Record<string, unknown>).MACRO
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
})
afterAll(() => {
  if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
  else (globalThis as Record<string, unknown>).MACRO = priorMacro
})

// A cliArg rule's relative pattern is rooted at the original cwd, so the
// fixtures under tmpdir need the filesystem-rooted form of "every .env".
const DENY_EVERY_ENV = 'Read(//**/.env)'

function withFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'batch-read-perm-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function touch(dir: string, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, '')
  return p
}

function contextFor(
  dir: string,
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map([[dir, { path: dir, source: 'cliArg' as const }]]),
    ...overrides,
  }
}

describe('checkBatchReadPermission', () => {
  test('allows when every path is in a working directory, echoing the real input', () => {
    withFixtures(dir => {
      const input = { file_paths: [touch(dir, 'a.ts'), touch(dir, 'b.ts')] }
      const decision = checkBatchReadPermission('Read', input.file_paths, input, contextFor(dir))
      expect(decision.behavior).toBe('allow')
      // Never `{}`: the harness applies updatedInput over the call's input.
      if (decision.behavior === 'allow') expect(decision.updatedInput).toBe(input)
    })
  })

  test('denies when a .env rule hits one file, naming only that one', () => {
    withFixtures(dir => {
      const a = touch(dir, 'a.ts')
      const env = touch(dir, '.env')
      const decision = checkBatchReadPermission(
        'Read',
        [a, env],
        { file_paths: [a, env] },
        contextFor(dir, { alwaysDenyRules: { cliArg: [DENY_EVERY_ENV] } }),
      )
      expect(decision.behavior).toBe('deny')
      if (decision.behavior === 'deny') {
        expect(decision.message).toContain(env)
        expect(decision.message).not.toContain(a)
        expect(decision.decisionReason.type).toBe('rule')
      }
    })
  })

  test('a deny on several files names each of them, and none of the rest', () => {
    withFixtures(dir => {
      const a = touch(dir, 'a.ts')
      const x = touch(dir, 'x.key')
      const y = touch(dir, 'y.key')
      const decision = checkBatchReadPermission(
        'Read',
        [x, a, y],
        { file_paths: [x, a, y] },
        contextFor(dir, { alwaysDenyRules: { cliArg: [`Read(/${x})`, `Read(/${y})`] } }),
      )
      expect(decision.behavior).toBe('deny')
      if (decision.behavior === 'deny') {
        expect(decision.message).toBe(
          `Permission to read the following paths has been denied:\n  - ${x}\n  - ${y}`,
        )
      }
    })
  })

  test('asks ONCE, listing every path outside the working directories', () => {
    withFixtures(dir => {
      const a = touch(dir, 'far-a.ts')
      const b = touch(dir, 'far-b.ts')
      const decision = checkBatchReadPermission(
        'Read',
        [a, b],
        { file_paths: [a, b] },
        getEmptyToolPermissionContext(),
      )
      expect(decision.behavior).toBe('ask')
      if (decision.behavior === 'ask') {
        expect(decision.message).toContain(a)
        expect(decision.message).toContain(b)
      }
    })
  })

  test('deny wins over ask when both are present', () => {
    withFixtures(dir => {
      const denied = touch(dir, 'denied.ts')
      const asked = touch(dir, 'asked.ts')
      const decision = checkBatchReadPermission(
        'Read',
        [asked, denied],
        { file_paths: [asked, denied] },
        {
          ...getEmptyToolPermissionContext(),
          alwaysDenyRules: { cliArg: [`Read(/${denied})`] },
        },
      )
      expect(decision.behavior).toBe('deny')
    })
  })

  test('an ask rule on one file keeps its rule, so bypass mode still asks', () => {
    // hasPermissionsToUseTool honours a `rule` ask even in bypassPermissions
    // (step 1f), and nothing else here would. Both files are outside the
    // working directories, so `a` asks first — with a workingDir reason,
    // which bypass mode waves through — and the rule on `b` must win.
    withFixtures(dir => {
      const a = touch(dir, 'a.ts')
      const b = touch(dir, 'b.ts')
      const decision = checkBatchReadPermission(
        'Read',
        [a, b],
        { file_paths: [a, b] },
        {
          ...getEmptyToolPermissionContext(),
          alwaysAskRules: { cliArg: [`Read(/${b})`] },
        },
      )
      expect(decision.behavior).toBe('ask')
      if (decision.behavior === 'ask') {
        expect(decision.decisionReason?.type).toBe('rule')
        expect(decision.message).toContain(a)
        expect(decision.message).toContain(b)
      }
    })
  })

  test('bypassPermissions does not reach past a deny rule', () => {
    withFixtures(dir => {
      const a = touch(dir, 'a.ts')
      const env = touch(dir, '.env')
      const decision = checkBatchReadPermission(
        'Read',
        [a, env],
        { file_paths: [a, env] },
        contextFor(dir, {
          mode: 'bypassPermissions',
          alwaysDenyRules: { cliArg: [DENY_EVERY_ENV] },
        }),
      )
      expect(decision.behavior).toBe('deny')
    })
  })
})
