import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/Tool.js'
import { runWithCwdOverride } from 'src/utils/fs/cwd.js'
import { FileStateCache } from 'src/utils/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/utils/fs/fsOperations.js'
import {
  checkRenamePermissions,
  type RenameInput,
  validateRenameInput,
} from 'src/tools/RenameTool/rename.js'

beforeAll(() => {
  setOriginalFsImplementation()
})

let dir: string
let ctx: ToolUseContext

function makeContext(mode: 'default' | 'bypassPermissions'): ToolUseContext {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    ...(mode === 'bypassPermissions' ? { mode } : {}),
  }
  return {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: () => {},
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
  } as unknown as ToolUseContext
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rename-perm-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const cfg = 1\n')
  ctx = makeContext('bypassPermissions')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('validateRenameInput', () => {
  test('rejects anything that is not a plain identifier', () => {
    expect(
      validateRenameInput({ symbol: 'cfg.*', replacement: 'config' }).result,
    ).toBe(false)
    expect(
      validateRenameInput({ symbol: 'cfg', replacement: 'a b' }).result,
    ).toBe(false)
  })

  test('rejects a no-op rename', () => {
    expect(
      validateRenameInput({ symbol: 'cfg', replacement: 'cfg' }).result,
    ).toBe(false)
  })

  test('rejects exclude without the token that makes the ids meaningful', () => {
    const r = validateRenameInput({
      symbol: 'cfg',
      replacement: 'config',
      exclude: ['s01'],
    })

    expect(r.result).toBe(false)
    expect(r.result === false && r.message).toMatch(/sitesToken/)
  })

  test('accepts a well-formed rename', () => {
    expect(
      validateRenameInput({ symbol: 'cfg', replacement: 'config' }).result,
    ).toBe(true)
  })
})

describe('checkRenamePermissions', () => {
  const input: RenameInput = { symbol: 'cfg', replacement: 'config' }

  test('preview never prompts — it writes nothing', async () => {
    ctx = makeContext('default')
    const decision = await runWithCwdOverride(dir, () =>
      checkRenamePermissions({ ...input, mode: 'preview' }, ctx),
    )

    expect(decision.behavior).toBe('allow')
  })

  test('an allow echoes the real input back', async () => {
    const decision = await runWithCwdOverride(dir, () =>
      checkRenamePermissions(input, ctx),
    )

    // checkBatchWritePermission's own allow carries `updatedInput: {}`, which
    // the harness would apply verbatim over the real input.
    expect(decision.behavior).toBe('allow')
    expect(decision.behavior === 'allow' && decision.updatedInput).toEqual(input)
  })

  test('asks before writing when the mode is not bypass', async () => {
    ctx = makeContext('default')
    const decision = await runWithCwdOverride(dir, () =>
      checkRenamePermissions(input, ctx),
    )

    expect(decision.behavior).toBe('ask')
  })
})
