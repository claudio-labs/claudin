// A Read of a memory file, end to end: readDispatch marks it with what the
// read saw of its frontmatter, and the result opens with the note
// (memoryAge.ts). The FileReadTool suites run under CLAUDIN_SIMPLE, where
// memory is off, so this one builds its own memory dir in a git project.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { makeContext, read } from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'
import { mapReadResultToToolResultBlock } from 'src/tools/FileReadTool/resultContent.js'
import type { Output } from 'src/tools/FileReadTool/schemas.js'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_SIMPLE', 'CLAUDIN_DISABLE_TOOL_RESULT_CACHE', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE'] as const
const saved = new Map<string, string | undefined>()
let savedProjectRoot: string
let root: string
let memDir: string

beforeAll(() => {
  setOriginalFsImplementation()
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  delete process.env.CLAUDIN_SIMPLE
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
  root = mkdtempSync(join(tmpdir(), 'memory-read-note-'))
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  savedProjectRoot = getProjectRoot()
  setProjectRoot(join(root, 'project'))
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  memDir = getPrivateMemPath()
})

afterAll(() => {
  setProjectRoot(savedProjectRoot)
  getPrivateMemPath.cache.clear?.()
  getGlobalMemPath.cache.clear?.()
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

async function readNote(name: string, content: string, offset?: number): Promise<string> {
  const path = join(memDir, name)
  writeFileSync(path, content)
  const result = await read(path, offset === undefined ? {} : { offset }, makeContext())
  const block = mapReadResultToToolResultBlock(result.data as Output, 'toolu_note')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}

describe('a Read of a memory file', () => {
  test('marked contradicts:, it opens with the names it disagrees with', async () => {
    const text = await readNote('timeout-b.md', '---\nname: timeout-b\ndescription: b\ntype: project\ncontradicts:\n  - timeout-a\n---\n\n45 seconds.\n')
    expect(text).toStartWith('<system-reminder>It is marked as contradicting `timeout-a`')
  })

  test('a read that starts past the frontmatter does not see the key', async () => {
    const text = await readNote('timeout-c.md', '---\nname: timeout-c\ndescription: c\ntype: project\ncontradicts:\n  - timeout-a\n---\n\n45 seconds.\n', 3)
    expect(text).not.toContain('contradicting')
  })
})
