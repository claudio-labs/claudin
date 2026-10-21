// A read file the model's own call changed, wired through the real tool loop:
// the call claims the change, so the watcher has nothing left to report as the
// user's — whether the call returned or threw, and for any tool that may write.
// A probe tool keeps this about the wiring, not about Bash.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import { refreshChangedFile } from 'src/agent/attachments/changedFile.js'
import { runToolUse } from 'src/agent/tools/toolExecution.js'
import { ShellError } from 'src/shared/errors.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import { createFileStateCacheWithSizeLimit, type FileState } from 'src/shared/fs/fileStateCache.js'
import { buildTool, getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

const FLAG = 'CLAUDIN_OWN_WRITES'
let dir: string
let priorFlag: string | undefined
const priorConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'own-writes-loop-')))
  // A paged error is saved under the config dir: keep it out of the real one.
  process.env.CLAUDIN_CONFIG_DIR = join(dir, 'config')
})
afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = priorConfigDir
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

type ProbeInput = { path: string; then: 'return' | 'throw'; readOnly?: boolean }

/** A tool that rewrites `path` while it runs, the way a python heredoc or a `git stash` would. */
const writeProbe = buildTool({
  name: 'WriteProbe',
  maxResultSizeChars: 10_000,
  async description() {
    return 'probe'
  },
  async prompt() {
    return 'probe'
  },
  get inputSchema() {
    return z.strictObject({ path: z.string(), then: z.enum(['return', 'throw']), readOnly: z.boolean().optional() })
  },
  isEnabled: () => true,
  isReadOnly: (input: ProbeInput) => input.readOnly === true,
  isConcurrencySafe: () => false,
  async checkPermissions(input: ProbeInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: ProbeInput) {
    writeAt(input.path, 'export const a = 2\n', 5)
    if (input.then === 'throw') throw new ShellError('', 'FAIL test/quote.test.ts', 1, false)
    return { data: 'ran' }
  },
  mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
    return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
  },
  renderToolUseMessage: () => null,
})

function contextFor(): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
    options: { tools: [writeProbe], mcpClients: [], isNonInteractiveSession: true, mainLoopModel: 'claude-opus-5-5' },
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

let calls = 0

/** Reads `name`, runs the probe on it, and returns what the model and the next prompt get. */
async function run(name: string, input: Omit<ProbeInput, 'path'>) {
  const path = join(dir, name)
  writeAt(path, 'export const a = 1\n', -60)
  const context = contextFor()
  context.readFileState.set(path, readEntry(path))
  const toolUse = { type: 'tool_use' as const, id: `toolu_own_${++calls}`, name: 'WriteProbe', input: { path, ...input } }
  const assistant = { type: 'assistant', uuid: `a-own-${calls}`, message: { id: `msg_own_${calls}`, role: 'assistant', content: [toolUse] } }
  const allow = (async (_tool: unknown, toolInput: unknown) => ({ behavior: 'allow', updatedInput: toolInput })) as never
  const updates: Array<{ message?: { type: string; message: { content: unknown }; refreshedFiles?: string[] } }> = []
  for await (const update of runToolUse(toolUse as never, assistant as never, allow, context)) updates.push(update as never)
  const result = updates.map(u => u.message).find(m => m?.type === 'user')!
  const later = await refreshChangedFile(path, path, context.readFileState.get(path)!, context)
  return { path, context, result, text: JSON.stringify(result.message.content), later }
}

const NOTE = (name: string) => `(1 file you had read changed under this call — your read now matches the disk: ${name})`

describe('a read file the call itself changed', () => {
  test('a call that returns claims it: the result names it, the next prompt says nothing', async () => {
    const { path, result, text, later } = await run('returned.ts', { then: 'return' })
    expect(text).toContain(NOTE('returned.ts'))
    expect(later).toBeNull()
    expect(result.refreshedFiles).toEqual([path])
  })

  // The gap Bash has today: a non-zero exit throws before its own refresh runs.
  test('a call that throws claims it too', async () => {
    const { path, result, text, later } = await run('threw.ts', { then: 'throw' })
    expect(text).toContain('FAIL test/quote.test.ts')
    expect(text).toContain(NOTE('threw.ts'))
    expect(later).toBeNull()
    expect(result.refreshedFiles).toEqual([path])
  })

  // A read-only call cannot have made the change, so it stays the watcher's.
  test('a read-only call claims nothing', async () => {
    const { result, text, later } = await run('read-only.ts', { then: 'return', readOnly: true })
    expect(text).not.toContain('you had read changed')
    expect(later).toMatchObject({ type: 'edited_text_file' })
    expect(result.refreshedFiles).toBeUndefined()
  })

  test('switch off: no line, and the watcher reports the change as before', async () => {
    delete process.env[FLAG]
    const { result, text, later } = await run('off.ts', { then: 'return' })
    expect(text).not.toContain('you had read changed')
    expect(later).toMatchObject({ type: 'edited_text_file' })
    expect(result.refreshedFiles).toBeUndefined()
  })
})

describe('what the call does not claim', () => {
  // A PostToolUse formatter, the IDE, the user: anything after the call returned.
  test('a change after the call is the watcher\u2019s', async () => {
    const { path, context, later } = await run('after.ts', { then: 'return' })
    expect(later).toBeNull()
    writeAt(path, 'export const a = 3\n', 30)
    expect(await refreshChangedFile(path, path, context.readFileState.get(path)!, context)).toMatchObject({ type: 'edited_text_file' })
  })
})

describe('the tools that get it with no code of their own', () => {
  // Inline sub-agents edit a clone of readFileState (runAgent.ts); the parent's
  // refresh after the Agent call is what keeps their edits off the watcher.
  // Agent stays read-only for permissions (it delegates them), so it says so apart.
  test('the Agent call may change files, while staying read-only for permissions', async () => {
    const { AgentTool } = await import('src/tools/AgentTool/AgentTool.js')
    const input = { description: 'd', prompt: 'p' } as never
    expect(AgentTool.isReadOnly(input)).toBe(true)
    expect(AgentTool.mayChangeFiles?.(input)).toBe(true)
  })
})
