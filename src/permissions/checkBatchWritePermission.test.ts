/**
 * Tests for checkBatchWritePermission — aggregated write-permission decision
 * across N paths for batch operations like LSP WorkspaceEdit.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { checkBatchWritePermission } from 'src/permissions/filesystem.js'

function withCwdContext(): ToolPermissionContext {
  // acceptEdits allows writes within working dirs without prompting
  const ctx = {
    ...getEmptyToolPermissionContext(),
    mode: 'acceptEdits' as const,
    additionalWorkingDirectories: new Map([
      [process.cwd(), { source: 'cli' as const }],
    ]),
  }
  return ctx as unknown as ToolPermissionContext
}

describe('checkBatchWritePermission', () => {
  let tmp: string

  function setup(): { tmp: string; cleanup: () => void } {
    const d = mkdtempSync(join(tmpdir(), 'batch-perm-'))
    return { tmp: d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
  }

  test('returns allow when all paths are in the working directory under acceptEdits', () => {
    tmp = mkdtempSync(join(tmpdir(), 'batch-perm-'))
    try {
      const a = join(process.cwd(), 'src', '.batch-perm-test-allow-a.tmp')
      const b = join(process.cwd(), 'src', '.batch-perm-test-allow-b.tmp')
      writeFileSync(a, 'x')
      writeFileSync(b, 'y')
      try {
        const decision = checkBatchWritePermission(
          'LSP',
          [a, b],
          withCwdContext(),
        )
        expect(decision.behavior).toBe('allow')
      } finally {
        rmSync(a, { force: true })
        rmSync(b, { force: true })
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('returns deny when any path matches a deny rule, listing the blocked paths', () => {
    const { tmp, cleanup } = setup()
    try {
      const a = join(tmp, 'a.ts')
      const b = join(tmp, 'b.ts')
      writeFileSync(a, '')
      writeFileSync(b, '')
      const ctx = {
        ...getEmptyToolPermissionContext(),
        mode: 'acceptEdits' as const,
        additionalWorkingDirectories: new Map([[tmp, { source: 'cli' as const }]]),
        // Filesystem-root-relative pattern via // prefix so the absolute
        // path under /tmp matches.
        alwaysDenyRules: {
          cliArg: [`Edit(/${a})`],
        },
      } as unknown as ToolPermissionContext

      const decision = checkBatchWritePermission('LSP', [a, b], ctx)
      expect(decision.behavior).toBe('deny')
      if (decision.behavior === 'deny') {
        expect(decision.message).toContain(a)
      }
    } finally {
      cleanup()
    }
  })

  test('returns ask when paths are outside the working directory', () => {
    const { tmp, cleanup } = setup()
    try {
      const outside = join(tmp, 'far-away.ts')
      writeFileSync(outside, '')
      const ctx = {
        ...getEmptyToolPermissionContext(),
        mode: 'default' as const,
      } as unknown as ToolPermissionContext
      const decision = checkBatchWritePermission('LSP', [outside], ctx)
      expect(decision.behavior).toBe('ask')
      if (decision.behavior === 'ask') {
        expect(decision.message).toContain(outside)
      }
    } finally {
      cleanup()
    }
  })

  test('returns allow for an empty path list', () => {
    const decision = checkBatchWritePermission(
      'LSP',
      [],
      getEmptyToolPermissionContext(),
    )
    expect(decision.behavior).toBe('allow')
  })

  test('deny wins over ask when both are present', () => {
    const { tmp, cleanup } = setup()
    try {
      const denied = join(tmp, 'denied.ts')
      const asked = join(tmp, 'asked.ts')
      writeFileSync(denied, '')
      writeFileSync(asked, '')
      const ctx = {
        ...getEmptyToolPermissionContext(),
        mode: 'default' as const,
        alwaysDenyRules: {
          cliArg: [`Edit(/${denied})`],
        },
      } as unknown as ToolPermissionContext
      const decision = checkBatchWritePermission(
        'LSP',
        [denied, asked],
        ctx,
      )
      expect(decision.behavior).toBe('deny')
    } finally {
      cleanup()
    }
  })
})
