// Every single-file agent write leaves a fingerprint of what it put on disk
// (fileHistoryRecordWrite), which a rewind later compares against to find the
// files someone changed since. Edit, Write and the simulated sed edit, through
// their real call paths with file history on. Patch and Rename go through
// commitStagedChanges, pinned in stagedWrite.commit.test.ts.
import { createHash, randomUUID } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { FileHistoryState } from 'src/shared/fs/fileHistory.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { applySedEdit } from 'src/tools/BashTool/applySedEdit.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDIN_DISABLE_FILE_CHECKPOINTING'] as const
const savedEnv: Record<string, string | undefined> = {}
let savedCwd = ''
let savedInteractive = false
let root: string
let dir: string
let history: FileHistoryState
let ctx: ToolUseContext

beforeAll(() => {
  setOriginalFsImplementation()
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedCwd = getOriginalCwd()
  savedInteractive = getIsInteractive()
  root = mkdtempSync(join(tmpdir(), 'write-fingerprint-'))
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setOriginalCwd(savedCwd)
  setIsInteractive(savedInteractive)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(join(root, 'project-'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING = '1'
  delete process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING
  setIsInteractive(false)
  setOriginalCwd(dir)
  history = {
    snapshots: [{ messageId: randomUUID(), trackedFileBackups: {}, timestamp: new Date() }],
    trackedFiles: new Set(),
    snapshotSequence: 1,
  }
  const toolPermissionContext = getEmptyToolPermissionContext()
  ctx = {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => {
      history = updater(history)
    },
    agentId: undefined,
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
})

/** `name` holding `content`, marked fully read. */
function readFile(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  ctx.readFileState.set(path, { content, timestamp: getFileModificationTime(path), offset: undefined, limit: undefined })
  return path
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('a write records what it left on disk', () => {
  test('Edit', async () => {
    const path = readFile('a.ts', 'const a = 1\n')
    await FileEditTool.call(
      { file_path: path, old_string: 'const a = 1', new_string: 'const a = 2' },
      ctx,
      undefined as never,
      { uuid: randomUUID() } as never,
    )
    expect(readFileSync(path, 'utf8')).toBe('const a = 2\n')
    expect(history.lastWrites).toEqual({ 'a.ts': sha256(path) })
  })

  test('Write, an existing file and a new one', async () => {
    const existing = readFile('a.ts', 'old\n')
    const created = join(dir, 'b.ts')
    for (const [path, content] of [
      [existing, 'new\n'],
      [created, 'fresh\n'],
    ] as const) {
      await FileWriteTool.call({ file_path: path, content }, ctx, undefined as never, { uuid: randomUUID() } as never)
    }
    expect(history.lastWrites).toEqual({ 'a.ts': sha256(existing), 'b.ts': sha256(created) })
  })

  test('the simulated sed edit', async () => {
    const path = readFile('s.txt', 'foo\n')
    await applySedEdit({ filePath: path, newContent: 'bar\n' }, ctx, { uuid: randomUUID() } as never)
    expect(history.lastWrites).toEqual({ 's.txt': sha256(path) })
  })
})
