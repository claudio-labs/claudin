/**
 * Wiring guard: a memory file carrying `paths:` reaches the model through the
 * `nested_memory` lane the first time a Read touches a matching file, and
 * only once per session — the same contract a path-scoped rule has.
 *
 * The memdir is redirected with CLAUDE_COWORK_MEMORY_PATH_OVERRIDE (the first
 * step of getAutoMemPath's resolution order) so no module is mocked; the
 * override dir is not under a `.claudin/`, so the globs anchor at the original
 * cwd — this repository — and the trigger path is a real file in it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { resetPathScopedMemoryCache } from 'src/memory/memdir/pathScopedMemories.js'
import { getNestedMemoryAttachmentsForFile } from 'src/agent/attachments/memory.js'

const SENTINEL = 'ZZ_PATH_SCOPED_MEMORY_SENTINEL_5b2e_ZZ'

const savedEnv = {
  override: process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
  simple: process.env.CLAUDIN_SIMPLE,
  disabled: process.env.CLAUDIN_DISABLE_AUTO_MEMORY,
}

let memoryDir: string
let memoryPath: string

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-scoped-wiring-'))
  memoryDir = join(root, 'memory') + sep
  await mkdir(join(memoryDir, 'team', 'bugs'), { recursive: true })
  memoryPath = join(memoryDir, 'team', 'bugs', 'bash-tool-gap.md')
  await writeFile(
    memoryPath,
    `---\nname: bash-tool-gap\ntype: project\npaths: src/tools/BashTool/**\n---\n\n${SENTINEL}\n`,
  )
  // The index never matches, whatever its frontmatter says.
  await writeFile(join(memoryDir, 'MEMORY.md'), '- [x](team/bugs/bash-tool-gap.md)\n')

  delete process.env.CLAUDIN_SIMPLE
  delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
  getAutoMemPath.cache.clear?.()
  resetPathScopedMemoryCache()
  expect(getAutoMemPath()).toBe(memoryDir)
})

afterAll(async () => {
  restoreEnv('CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', savedEnv.override)
  restoreEnv('CLAUDIN_SIMPLE', savedEnv.simple)
  restoreEnv('CLAUDIN_DISABLE_AUTO_MEMORY', savedEnv.disabled)
  getAutoMemPath.cache.clear?.()
  resetPathScopedMemoryCache()
  await rm(join(memoryDir, '..'), { recursive: true, force: true })
})

function makeContext(): ToolUseContext {
  return {
    readFileState: new FileStateCache(100, 10_000_000),
    loadedNestedMemoryPaths: new Set<string>(),
  } as unknown as ToolUseContext
}

const appState = {
  toolPermissionContext: {
    additionalWorkingDirectories: new Map(),
  } as unknown as ToolPermissionContext,
}

async function attachedMemoryPaths(
  context: ToolUseContext,
  target: string,
): Promise<string[]> {
  const attachments = await getNestedMemoryAttachmentsForFile(
    target,
    context,
    appState,
  )
  return attachments
    .filter(a => a.type === 'nested_memory')
    .map(a => (a.type === 'nested_memory' ? a.path : ''))
    .filter(path => path.startsWith(memoryDir))
}

describe('path-scoped memories ride the nested_memory lane', () => {
  const matching = join(getOriginalCwd(), 'src', 'tools', 'BashTool', 'BashTool.ts')
  const unrelated = join(getOriginalCwd(), 'src', 'agent', 'query.ts')

  test('a Read under the globs attaches the memory once, then never again in the session', async () => {
    const context = makeContext()

    expect(await attachedMemoryPaths(context, matching)).toEqual([memoryPath])
    expect(context.readFileState.has(memoryPath)).toBe(true)

    expect(await attachedMemoryPaths(context, matching)).toEqual([])
  })

  test('a Read outside the globs attaches nothing from the memdir', async () => {
    expect(await attachedMemoryPaths(makeContext(), unrelated)).toEqual([])
  })

  test('a fresh context (post-compaction) attaches it again', async () => {
    expect(await attachedMemoryPaths(makeContext(), matching)).toEqual([memoryPath])
  })
})
