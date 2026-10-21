import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { refreshChangedFile } from 'src/agent/attachments/changedFile.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileState,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import { type FileChangingTool, refreshOwnWrites, settleOwnWrites } from 'src/agent/attachments/ownWrites.js'

const FLAG = 'CLAUDIN_OWN_WRITES'
let dir: string
let priorFlag: string | undefined

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'own-writes-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  priorFlag = process.env[FLAG]
  process.env[FLAG] = '1'
})
afterEach(() => {
  if (priorFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = priorFlag
})

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

/** Writes `content` with an mtime `seconds` from now: past or future, never ambiguous. */
function writeAt(path: string, content: string, seconds: number): void {
  writeFileSync(path, content)
  const when = new Date(Date.now() + seconds * 1000)
  utimesSync(path, when, when)
}

/** What a whole-file Read leaves behind. */
function readEntry(path: string): FileState {
  return { content: readFileSync(path, 'utf8'), timestamp: getFileModificationTime(path), offset: 1, limit: undefined }
}

describe('refreshOwnWrites', () => {
  test('a file the command rewrote matches the disk, and the next prompt says nothing', async () => {
    const p = join(dir, 'quote.ts')
    writeAt(p, 'export const a = 1\n', -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, readEntry(p))

    const startedAt = Date.now()
    writeAt(p, 'export const a = 2\n', 5) // the python heredoc
    const own = await refreshOwnWrites(ctx.readFileState, startedAt, dir)

    expect(own.changed).toEqual([p])
    expect(own.note).toBe('(1 file you had read changed under this call — your read now matches the disk: quote.ts)')
    const entry = ctx.readFileState.get(p)!
    // A Read's content carries no final newline, and the entry is now one.
    expect(entry).toMatchObject({ content: 'export const a = 2', timestamp: getFileModificationTime(p), dedupExempt: true })
    expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
  })

  // The control: without the refresh, the watcher reports the same change.
  test('flag off: nothing moves, and the next prompt reports the change as before', async () => {
    delete process.env[FLAG]
    const p = join(dir, 'off.ts')
    writeAt(p, 'export const a = 1\n', -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, readEntry(p))

    const startedAt = Date.now()
    writeAt(p, 'export const a = 2\n', 5)
    expect(await refreshOwnWrites(ctx.readFileState, startedAt, dir)).toEqual({ changed: [], note: null })
    expect(await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)).toMatchObject({ type: 'edited_text_file' })
  })

  test("a change from before the command started is still the watcher's to report", async () => {
    const p = join(dir, 'before.ts')
    writeAt(p, 'export const a = 1\n', -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, readEntry(p))
    writeAt(p, 'export const a = 2\n', -30) // a linter, between the read and this command

    const own = await refreshOwnWrites(ctx.readFileState, Date.now(), dir)
    expect(own.changed).toEqual([])
    expect(await refreshChangedFile(p, p, ctx.readFileState.get(p)!, ctx)).toMatchObject({ type: 'edited_text_file' })
  })

  test('a file the command did not touch is left alone', async () => {
    const p = join(dir, 'untouched.ts')
    writeAt(p, 'export const a = 1\n', -60)
    const ctx = makeContext()
    const entry = readEntry(p)
    ctx.readFileState.set(p, entry)
    expect((await refreshOwnWrites(ctx.readFileState, Date.now(), dir)).changed).toEqual([])
    expect(ctx.readFileState.get(p)).toBe(entry)
  })

  // An Edit in the same response, or a Read after the write, already dated the entry to it.
  test('an entry already current is left alone', async () => {
    const p = join(dir, 'current.ts')
    const startedAt = Date.now()
    writeAt(p, 'export const a = 2\n', 5)
    const ctx = makeContext()
    const entry = readEntry(p)
    ctx.readFileState.set(p, entry)
    expect((await refreshOwnWrites(ctx.readFileState, startedAt, dir)).changed).toEqual([])
    expect(ctx.readFileState.get(p)).toBe(entry)
  })

  test('a range entry keeps the slices that still match and reports nothing later', async () => {
    const p = join(dir, 'range.ts')
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    writeAt(p, `${lines.join('\n')}\n`, -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, {
      content: `${lines.slice(9, 19).join('\n')}\n`,
      timestamp: getFileModificationTime(p),
      offset: 10,
      limit: 10,
    })

    const startedAt = Date.now()
    lines[29] = 'line 30, edited'
    writeAt(p, `${lines.join('\n')}\n`, 5)
    const own = await refreshOwnWrites(ctx.readFileState, startedAt, dir)

    expect(own.changed).toEqual([p])
    const entry = ctx.readFileState.get(p)!
    expect(entry).toMatchObject({ offset: 10, limit: 10, timestamp: getFileModificationTime(p), dedupExempt: true })
    expect(await refreshChangedFile(p, p, entry, ctx)).toBeNull()
  })

  test('an outline-only entry is not taken for a read of the file', async () => {
    const p = join(dir, 'outline.ts')
    writeAt(p, 'export const a = 1\n', -60)
    const ctx = makeContext()
    const entry: FileState = { ...readEntry(p), isPartialView: true }
    ctx.readFileState.set(p, entry)
    const startedAt = Date.now()
    writeAt(p, 'export const a = 2\n', 5)
    expect((await refreshOwnWrites(ctx.readFileState, startedAt, dir)).changed).toEqual([])
    expect(ctx.readFileState.get(p)).toBe(entry)
  })

  test('several files are named in order, relative to where the command ran', async () => {
    // Set first-to-last, so the cache walks them last-to-first.
    const first = join(dir, 'a-first.ts')
    const second = join(dir, 'b-second.ts')
    const ctx = makeContext()
    for (const p of [first, second]) {
      writeAt(p, 'x\n', -60)
      ctx.readFileState.set(p, readEntry(p))
    }
    const startedAt = Date.now()
    for (const p of [first, second]) writeAt(p, 'y\n', 5)
    const own = await refreshOwnWrites(ctx.readFileState, startedAt, dir)
    expect(own.note).toBe('(2 files you had read changed under this call — your read now matches the disk: a-first.ts, b-second.ts)')
  })

  test('a file outside where the call ran is named whole', async () => {
    const p = join(dir, 'outside.ts')
    writeAt(p, 'x\n', -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, readEntry(p))
    const startedAt = Date.now()
    writeAt(p, 'y\n', 5)
    const own = await refreshOwnWrites(ctx.readFileState, startedAt, join(dir, 'elsewhere'))
    expect(own.note).toBe(`(1 file you had read changed under this call — your read now matches the disk: ${p})`)
  })
})

describe('settleOwnWrites: which calls may claim a change', () => {
  /** Whether `tool`'s call claims a read file rewritten while it ran. */
  async function claims(tool: FileChangingTool): Promise<boolean> {
    const p = join(dir, `settle-${Math.random().toString(36).slice(2)}.ts`)
    writeAt(p, 'x\n', -60)
    const ctx = makeContext()
    ctx.readFileState.set(p, readEntry(p))
    const startedAt = Date.now()
    writeAt(p, 'y\n', 5)
    return (await settleOwnWrites(tool, {}, ctx.readFileState, startedAt, dir)).changed.length === 1
  }

  test('a call that may write claims it; a read-only one does not', async () => {
    expect(await claims({ isReadOnly: () => false })).toBe(true)
    expect(await claims({ isReadOnly: () => true })).toBe(false)
  })

  // Agent: read-only for permissions, yet its sub-agent edits.
  test('mayChangeFiles overrides isReadOnly, either way', async () => {
    expect(await claims({ isReadOnly: () => true, mayChangeFiles: () => true })).toBe(true)
    expect(await claims({ isReadOnly: () => false, mayChangeFiles: () => false })).toBe(false)
  })

  test('a tool that cannot say is taken to write, as buildTool assumes', async () => {
    const throwing = () => {
      throw new Error('no answer for this input')
    }
    expect(await claims({ isReadOnly: throwing })).toBe(true)
  })

  test('switch off: nothing is claimed', async () => {
    delete process.env[FLAG]
    expect(await claims({ isReadOnly: () => false })).toBe(false)
  })
})

// What the tool loop makes of a real Bash command, in a child process so the
// bootstrap cwd it sets cannot leak into the files that run after this one.
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const CALL_PROBE = `
const src = path => ${JSON.stringify(join(REPO_ROOT, 'src'))} + '/' + path
const { readFileSync } = await import('fs')
const { setOriginalCwd } = await import(src('platform/bootstrap/state.js'))
const { setCwd } = await import(src('shared/proc/Shell.js'))
const { getDefaultAppState } = await import(src('terminal/state/AppStateStore.js'))
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import(src('shared/fs/fileStateCache.js'))
const { getFileModificationTime } = await import(src('shared/fs/file.js'))
const { refreshChangedFile } = await import(src('agent/attachments/changedFile.js'))
const { runToolUse } = await import(src('agent/tools/toolExecution.js'))
const { BashTool } = await import(src('tools/BashTool/BashTool.js'))
const dir = process.env.PROBE_DIR
const file = dir + '/quote.ts'
setOriginalCwd(dir)
setCwd(dir)
let appState = getDefaultAppState()
const context = {
  abortController: new AbortController(),
  getAppState: () => appState,
  setAppState: update => { appState = update(appState) },
  readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
  messages: [],
  options: { tools: [BashTool], mcpClients: [], isNonInteractiveSession: true, mainLoopModel: 'claude-opus-5-5' },
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
}
// What a whole-file Read left behind.
context.readFileState.set(file, { content: readFileSync(file, 'utf8'), timestamp: getFileModificationTime(file), offset: 1, limit: undefined })
const toolUse = { type: 'tool_use', id: 'toolu_probe', name: 'Bash', input: { command: process.env.PROBE_COMMAND } }
const assistant = { type: 'assistant', uuid: 'a-probe', message: { id: 'msg_probe', role: 'assistant', content: [toolUse] } }
const allow = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })
let result
for await (const update of runToolUse(toolUse, assistant, allow, context)) {
  if (update.message?.type === 'user') result = update.message
}
const later = await refreshChangedFile(file, file, context.readFileState.get(file), context)
const block = result.message.content[0]
process.stdout.write(JSON.stringify({ text: String(block.content), isError: block.is_error === true, refreshedFiles: result.refreshedFiles ?? null, later }))
process.exit(0)
`

type Probed = { text: string; isError: boolean; refreshedFiles: string[] | null; later: unknown }

describe('the tool loop: a read file a Bash command rewrote', () => {
  const edit = `python3 -c "open('quote.ts','w').write('export const a = 2\\\\n')"`
  const run = (flag: boolean, command: string): Probed => {
    const probeDir = realpathSync(mkdtempSync(join(tmpdir(), 'own-writes-call-')))
    const configDir = mkdtempSync(join(tmpdir(), 'own-writes-config-'))
    try {
      writeAt(join(probeDir, 'quote.ts'), 'export const a = 1\n', -60)
      const env: Record<string, string | undefined> = {
        ...process.env,
        NODE_ENV: 'test',
        NODE_NO_WARNINGS: '1',
        CLAUDIN_CONFIG_DIR: configDir,
        PROBE_DIR: probeDir,
        PROBE_COMMAND: command,
      }
      if (flag) env[FLAG] = '1'
      else delete env[FLAG]
      const child = spawnSync(process.execPath, ['--preload', './src/stubs/test-preload.ts', '-e', CALL_PROBE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env,
        timeout: 60_000,
      })
      if (child.status !== 0) throw new Error(`call() probe failed (exit ${child.status})\n${child.stdout}\n${child.stderr}`)
      const probed = JSON.parse(child.stdout) as Probed
      return { ...probed, refreshedFiles: probed.refreshedFiles?.map(p => p.replace(probeDir, '<dir>')) ?? null }
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  }
  const LINE = '(1 file you had read changed under this call — your read now matches the disk: quote.ts)'

  test('switch on: the result names it, and the next prompt carries no change notice', () => {
    const { text, isError, refreshedFiles, later } = run(true, edit)
    expect(isError).toBe(false)
    expect(text.endsWith(`\n\n${LINE}`)).toBe(true)
    expect(refreshedFiles).toEqual(['<dir>/quote.ts'])
    expect(later).toBeNull()
  })

  // A non-zero exit throws inside BashTool.call(), past any refresh of its own.
  test('switch on, the command then failing: the edit is claimed all the same', () => {
    const { text, isError, refreshedFiles, later } = run(true, `${edit} && echo 'FAIL test/quote.test.ts' && exit 1`)
    expect(isError).toBe(true)
    expect(text).toContain('FAIL test/quote.test.ts')
    expect(text.endsWith(`\n\n${LINE}`)).toBe(true)
    expect(refreshedFiles).toEqual(['<dir>/quote.ts'])
    expect(later).toBeNull()
  })

  test('switch off: no line, and the change notice follows as before', () => {
    const { text, refreshedFiles, later } = run(false, edit)
    expect(text).not.toContain('you had read changed')
    expect(refreshedFiles).toBeNull()
    expect(later).toMatchObject({ type: 'edited_text_file' })
  })
})
