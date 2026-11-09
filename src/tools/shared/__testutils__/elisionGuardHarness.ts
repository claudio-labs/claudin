// Shared setup for the elision-guard suites of Edit, Write and Patch: a temp
// dir of files marked fully read, a tool context, file checkpointing off and
// CLAUDIN_ELISION_GUARD cleared before each test. Call useElisionGuardEnv() at
// a test file's top level so its hooks register in that file's scope.
import { afterAll, beforeAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

export const ORIGINAL = 'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 2\n}\n'
export const ELIDED = 'export function a() {\n  return 10\n}\n\n// ... existing code ...\n'

export function useElisionGuardEnv(): {
  ctx: () => ToolUseContext
  /** `name` holding `content` (null: absent), marked fully read. */
  fresh: (name: string, content: string | null) => string
} {
  const saved = {
    CLAUDIN_DISABLE_FILE_CHECKPOINTING: process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING,
    CLAUDIN_ELISION_GUARD: process.env.CLAUDIN_ELISION_GUARD,
  }
  let dir = ''
  let ctx: ToolUseContext

  beforeAll(() => {
    setOriginalFsImplementation()
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    dir = mkdtempSync(join(tmpdir(), 'elision-guard-'))
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    delete process.env.CLAUDIN_ELISION_GUARD
    const toolPermissionContext = getEmptyToolPermissionContext()
    ctx = {
      abortController: new AbortController(),
      readFileState: new FileStateCache(100, 10_000_000),
      updateFileHistoryState: () => {},
      agentId: undefined,
      getAppState: () => ({ toolPermissionContext }),
      setAppState: () => {},
      options: {},
    } as unknown as ToolUseContext
  })

  return {
    ctx: () => ctx,
    fresh: (name, content) => {
      const path = join(dir, name)
      rmSync(path, { force: true })
      if (content === null) return path
      writeFileSync(path, content)
      ctx.readFileState.set(path, {
        content,
        timestamp: getFileModificationTime(path),
        offset: undefined,
        limit: undefined,
      })
      return path
    },
  }
}
