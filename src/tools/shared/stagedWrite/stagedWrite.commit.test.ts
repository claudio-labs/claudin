// commitStagedChanges — the write half Patch and Rename share — against real
// files: the order it writes in, the read state it leaves behind, the
// file-history backups it takes before each write, and the rollback when a
// change fails part-way.
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, getOriginalCwd, setIsInteractive, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { FileHistoryState } from 'src/shared/fs/fileHistory.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { setOriginalFsImplementation } from 'src/shared/fs/fsOperations.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from 'src/tools/FileEditTool/constants.js'
import {
  commitStagedChanges,
  type StagedChange,
  stageContentReplacement,
  writeChange,
} from 'src/tools/shared/stagedWrite/stagedWrite.js'

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
  root = mkdtempSync(join(tmpdir(), 'staged-commit-'))
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
  ctx = {
    abortController: new AbortController(),
    readFileState: new FileStateCache(100, 10_000_000),
    updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState) => {
      history = updater(history)
    },
    agentId: undefined,
    getAppState: () => ({}),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
})

afterEach(() => {
  setOriginalFsImplementation()
})

function file(name: string, body: string): string {
  const abs = join(dir, name)
  writeFileSync(abs, body)
  return abs
}

function change(type: StagedChange['type'], absPath: string, oldContent: string | null, newContent: string, movePath?: string): StagedChange {
  return {
    type,
    absPath,
    ...(movePath ? { movePath } : {}),
    oldContent,
    newContent,
    encoding: 'utf8',
    endings: 'LF',
    additions: 0,
    deletions: 0,
    structuredPatch: [],
  }
}

describe('commitStagedChanges', () => {
  test('writes every change and records each surviving file as read', async () => {
    const a = file('a.txt', 'one\n')
    const added = join(dir, 'sub', 'new.txt')
    const { committed, newMessages } = await commitStagedChanges(
      [stageContentReplacement(a, 'two\n'), change('add', added, null, 'fresh\n')],
      ctx,
      randomUUID(),
    )
    expect(committed.map(c => c.type)).toEqual(['update', 'add'])
    expect(newMessages).toEqual([])
    expect(readFileSync(a, 'utf8')).toBe('two\n')
    expect(readFileSync(added, 'utf8')).toBe('fresh\n')
    expect(ctx.readFileState.get(a)?.content).toBe('two\n')
    expect(ctx.readFileState.get(added)?.content).toBe('fresh\n')
    expect(ctx.readFileState.get(a)?.isPartialView).toBeUndefined()
  })

  test('markReadStatePartial marks the rewritten files as a partial view', async () => {
    const a = file('a.txt', 'one\n')
    await commitStagedChanges([stageContentReplacement(a, 'two\n')], ctx, randomUUID(), { markReadStatePartial: true })
    expect(ctx.readFileState.get(a)?.isPartialView).toBe(true)
  })

  test('a delete drops the read state; a move moves it', async () => {
    const gone = file('gone.txt', 'bye\n')
    const from = file('from.txt', 'body\n')
    const to = join(dir, 'to.txt')
    ctx.readFileState.set(gone, { content: 'bye\n', timestamp: 1, offset: undefined, limit: undefined })
    ctx.readFileState.set(from, { content: 'body\n', timestamp: 1, offset: undefined, limit: undefined })

    await commitStagedChanges(
      [change('delete', gone, 'bye\n', ''), change('move', from, 'body\n', 'body moved\n', to)],
      ctx,
      randomUUID(),
    )

    expect(existsSync(gone)).toBe(false)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('body moved\n')
    expect(ctx.readFileState.get(gone)).toBeUndefined()
    expect(ctx.readFileState.get(from)).toBeUndefined()
    expect(ctx.readFileState.get(to)?.content).toBe('body moved\n')
  })

  test('backs every target up in file history before writing, a move both of its ends', async () => {
    const a = file('a.txt', 'one\n')
    const from = file('from.txt', 'body\n')
    await commitStagedChanges(
      [stageContentReplacement(a, 'two\n'), change('move', from, 'body\n', 'body\n', join(dir, 'to.txt'))],
      ctx,
      randomUUID(),
    )
    expect([...history.trackedFiles].sort()).toEqual(['a.txt', 'from.txt', 'to.txt'])
    const backups = history.snapshots.at(-1)!.trackedFileBackups
    expect(backups['a.txt']?.backupFileName).not.toBeNull()
    expect(backups['to.txt']?.backupFileName).toBeNull()
  })

  test('takes no backup with file history off', async () => {
    process.env.CLAUDIN_DISABLE_FILE_CHECKPOINTING = '1'
    const a = file('a.txt', 'one\n')
    await commitStagedChanges([stageContentReplacement(a, 'two\n')], ctx, randomUUID())
    expect(history.trackedFiles.size).toBe(0)
    expect(readFileSync(a, 'utf8')).toBe('two\n')
  })

  test('a file changed since it was staged rolls back what was already written and throws', async () => {
    const a = file('a.txt', 'one\n')
    const b = file('b.txt', 'bee\n')
    const first = stageContentReplacement(a, 'two\n')
    const second = stageContentReplacement(b, 'bee two\n')
    writeFileSync(b, 'edited meanwhile\n')

    await expect(commitStagedChanges([first, second], ctx, randomUUID())).rejects.toThrow(FILE_UNEXPECTEDLY_MODIFIED_ERROR)

    expect(readFileSync(a, 'utf8')).toBe('one\n')
    expect(readFileSync(b, 'utf8')).toBe('edited meanwhile\n')
    expect(ctx.readFileState.get(a)).toBeUndefined()
  })

  test('an abort before a write stops the batch and rolls back', async () => {
    const a = file('a.txt', 'one\n')
    ctx.abortController.abort()
    await expect(commitStagedChanges([stageContentReplacement(a, 'two\n')], ctx, randomUUID())).rejects.toThrow()
    expect(readFileSync(a, 'utf8')).toBe('one\n')
  })
})

describe('writeChange', () => {
  test('a delete unlinks the file', () => {
    const gone = file('gone.txt', 'bye\n')
    writeChange(change('delete', gone, 'bye\n', ''))
    expect(existsSync(gone)).toBe(false)
  })
})
