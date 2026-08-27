// The read-before-edit gate vs the local tool-result cache.
//
// A cache HIT returns the stored result and never runs call() (Tool.ts
// wrapCallWithCache), so the `readFileState.set` that call() performs is
// skipped. The model still receives the full body — which is why this looked
// like nothing was wrong — while Edit/apply_patch/Write see no entry and refuse
// with "has not been read yet". Reproduced from a live session where it fired
// five times, each cleared by an identical second Read.
//
// The env killswitch is cleared here on purpose: readGateScenarios.test.ts sets
// CLAUDIN_DISABLE_TOOL_RESULT_CACHE=1 for its whole file, which is exactly why
// that suite could not see this.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { validateApplyPatchInput } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { __resetForTests } from 'src/agent/tools/toolResultCache.js'

let dir: string
let priorKillswitch: string | undefined

beforeAll(() => {
  priorKillswitch = process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
  delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
  setOriginalFsImplementation()
  dir = mkdtempSync(join(tmpdir(), 'read-gate-cache-hit-'))
})

afterAll(() => {
  if (priorKillswitch === undefined) {
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
  } else {
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = priorKillswitch
  }
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  __resetForTests()
})

function makeContext(): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    updateFileHistoryState: () => {},
    agentId: undefined,
    messages: [],
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

function read(ctx: ToolUseContext, path: string) {
  return FileReadTool.call({ file_path: path } as never, ctx)
}

function patch(ctx: ToolUseContext, path: string, body: string) {
  return validateApplyPatchInput(
    {
      patchText: `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch`,
    },
    ctx,
  )
}

describe('a Read served from the tool-result cache still opens the write gate', () => {
  test('another context primed the cache — this one can still patch', async () => {
    const p = join(dir, 'a.ts')
    writeFileSync(p, 'export function one(): number {\n  return 1\n}\n')

    // A forked sub-agent runs in-process on a CLONE of readFileState but shares
    // the process-global tool-result cache (runAgent.ts), so its Read is enough
    // to make the main thread's identical Read a hit.
    const fork = makeContext()
    const main = makeContext()

    await read(fork, p)
    const hit = await read(main, p)
    expect((hit.data as { type: string }).type).toBe('text')

    expect(main.readFileState.has(p)).toBe(true)
    const res = await patch(main, p, '@@\n-  return 1\n+  return 2')
    expect(res.result).toBe(true)
  })

  test('after its own entry is evicted, one context recovers on the re-read', async () => {
    const p = join(dir, 'b.ts')
    writeFileSync(p, 'export function two(): number {\n  return 2\n}\n')

    const main = makeContext()
    await read(main, p)
    // Stands in for the LRU dropping the entry: readFileState holds 100 paths
    // and the session that produced this bug touched 219.
    main.readFileState.delete(p)

    await read(main, p)
    expect(main.readFileState.has(p)).toBe(true)
    const res = await patch(main, p, '@@\n-  return 2\n+  return 3')
    expect(res.result).toBe(true)
  })

  test('the seeded entry describes the range that was read', async () => {
    const p = join(dir, 'c.ts')
    writeFileSync(p, 'a\nb\nc\nd\ne\nf\n')

    const fork = makeContext()
    const main = makeContext()
    const input = { file_path: p, offset: 3, limit: 2 } as never
    await FileReadTool.call(input, fork)
    await FileReadTool.call(input, main)

    const seeded = main.readFileState.get(p)
    expect(seeded?.offset).toBe(3)
    expect(seeded?.limit).toBe(2)
    expect(seeded?.content).toBe(fork.readFileState.get(p)?.content)
  })

  test('a partial-view entry is left alone — the gate still refuses', async () => {
    const p = join(dir, 'd.ts')
    writeFileSync(p, 'export function four(): number {\n  return 4\n}\n')

    const fork = makeContext()
    await read(fork, p)

    // An outline/stand-down entry is state call() owns; a replayed body must
    // not promote it to "the model has seen the file".
    const main = makeContext()
    main.readFileState.set(p, {
      content: '',
      timestamp: 1,
      offset: 1,
      limit: undefined,
      isPartialView: true,
    })
    await read(main, p)

    expect(main.readFileState.get(p)?.isPartialView).toBe(true)
    const res = await patch(main, p, '@@\n-  return 4\n+  return 5')
    expect(res.result).toBe(false)
  })
})
