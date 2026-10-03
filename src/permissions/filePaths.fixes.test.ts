/**
 * permissions/filePaths: the fix applied by the rewrite (finding 5) and the
 * behaviour of the cached forms, which the characterization suites leave
 * unpinned.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions.js'
import { isPathAllowed } from 'src/permissions/pathValidation.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import {
  openLab,
  permissionContext,
  type Lab,
} from 'src/permissions/__testutils__/filePathsLab.js'

let lab: Lab
beforeEach(() => {
  lab = openLab()
})
afterEach(() => {
  lab.close()
})

describe('an empty list of forms proves nothing (finding 5, fix)', () => {
  test('it is not inside any working directory', () => {
    const inside = lab.file(join(lab.project, 'a.ts'))
    expect(pathInAllowedWorkingPath(inside, permissionContext(), [])).toBe(false)
    expect(pathInAllowedWorkingPath(inside, permissionContext({ dirs: ['/'] }), [])).toBe(false)
  })

  test('so isPathAllowed gives it no working-directory opening', () => {
    const inside = lab.file(join(lab.project, 'a.ts'))
    const cases: Array<['read' | 'write' | 'create', ReturnType<typeof permissionContext>]> = [
      ['read', permissionContext()],
      ['write', permissionContext({ mode: 'acceptEdits' })],
      ['create', permissionContext({ mode: 'acceptEdits' })],
    ]
    for (const [op, ctx] of cases) {
      expect(isPathAllowed(inside, ctx, op)).toEqual({ allowed: true })
      expect(isPathAllowed(inside, ctx, op, [])).toEqual({ allowed: false })
    }
  })

  test('nor a sandbox allowlist opening', () => {
    const allowed = lab.dir(join(lab.root, 'sbx'))
    const on = spyOn(SandboxManager, 'isSandboxingEnabled').mockImplementation(() => true)
    const cfg = spyOn(SandboxManager, 'getFsWriteConfig').mockImplementation(() => ({
      allowOnly: [allowed],
      denyWithinAllow: [],
    }))
    try {
      const target = join(allowed, 'f.txt')
      expect(isPathAllowed(target, permissionContext(), 'write').allowed).toBe(true)
      expect(isPathAllowed(target, permissionContext(), 'write', [])).toEqual({ allowed: false })
    } finally {
      on.mockRestore()
      cfg.mockRestore()
    }
  })
})

describe('forms supplied to isPathAllowed replace resolving the path', () => {
  test('in the protected-path check too', () => {
    const rc = join(lab.project, '.bashrc')
    const ctx = permissionContext({ mode: 'acceptEdits' })
    expect(isPathAllowed(rc, ctx, 'write').decisionReason?.type).toBe('safetyCheck')
    expect(isPathAllowed(rc, ctx, 'write', [join(lab.project, 'a.ts')])).toEqual({ allowed: true })
  })
})

describe('configured locations are resolved once per path string', () => {
  test('a working directory link re-pointed later keeps its first target', () => {
    const first = lab.dir(join(lab.root, 'first'))
    const second = lab.dir(join(lab.root, 'second'))
    const alias = lab.link(join(lab.root, 'alias'), first)
    const ctx = permissionContext({ dirs: [alias] })
    const inFirst = lab.file(join(first, 'a.ts'))
    const inSecond = lab.file(join(second, 'b.ts'))

    expect(pathInAllowedWorkingPath(inFirst, ctx)).toBe(true)
    rmSync(alias)
    symlinkSync(second, alias)
    expect(pathInAllowedWorkingPath(inSecond, ctx)).toBe(false)
    expect(pathInAllowedWorkingPath(inFirst, ctx)).toBe(true)
  })
})
