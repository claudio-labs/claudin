// Tool.advise, wired through the real tool loop: the note a tool hands back is
// appended to its result — success or error — and asked for exactly once.
// Bash is the one production user; a probe tool keeps this about the wiring.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import { adviceNoteAfterCall, runToolUse } from 'src/agent/tools/toolExecution.js'
import {
  buildTool,
  getEmptyToolPermissionContext,
  type ToolAdvice,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'

type Probe = { advised: number; ran: number }

function probeTool(probe: Probe, advice: (input: { mode: string }) => ToolAdvice | null) {
  return buildTool({
    name: 'AdviceProbe',
    maxResultSizeChars: 10_000,
    async description() {
      return 'probe'
    },
    async prompt() {
      return 'probe'
    },
    get inputSchema() {
      return z.strictObject({ mode: z.string() })
    },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions(input: { mode: string }) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
    advise(input: { mode: string }) {
      probe.advised++
      return advice(input)
    },
    async call(input: { mode: string }) {
      probe.ran++
      if (input.mode === 'throw') throw new Error('the command failed')
      return { data: `ran ${input.mode}` }
    },
    mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
    },
    renderToolUseMessage: () => null,
  })
}

/** A deferred tool the advice can point at, and the ToolSearch that loads it. */
const deferredTarget = buildTool({
  name: 'DeferredTarget',
  shouldDefer: true,
  maxResultSizeChars: 1_000,
  async description() {
    return 'target'
  },
  async prompt() {
    return 'target'
  },
  get inputSchema() {
    return z.strictObject({})
  },
  isEnabled: () => true,
  async call() {
    return { data: 'x' }
  },
  mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
    return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
  },
  renderToolUseMessage: () => null,
})
const toolSearch = { ...deferredTarget, name: 'ToolSearch', shouldDefer: false }

function contextFor(tools: unknown[], messages: unknown[] = []): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages,
    options: {
      tools,
      mcpClients: [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-opus-5-5',
    },
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function run(
  mode: string,
  advice: (input: { mode: string }) => ToolAdvice | null,
  messages: unknown[] = [],
) {
  const probe: Probe = { advised: 0, ran: 0 }
  const tool = probeTool(probe, advice)
  const toolUse = { type: 'tool_use' as const, id: 'toolu_advice', name: 'AdviceProbe', input: { mode } }
  const assistant = {
    type: 'assistant',
    uuid: 'a-advice',
    message: { id: 'msg_advice', role: 'assistant', content: [toolUse] },
  }
  const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  const results: unknown[] = []
  const context = contextFor([tool, deferredTarget, toolSearch], messages)
  for await (const update of runToolUse(toolUse as never, assistant as never, allow, context)) {
    results.push(update)
  }
  return { probe, texts: JSON.stringify(results) }
}

const NOTE = 'AdviceProbe has a better tool for this.'

describe('Tool.advise in the tool loop', () => {
  const savedToolSearch = process.env.ENABLE_TOOL_SEARCH
  const savedReminders = process.env.CLAUDIN_DISABLE_TOOL_REMINDERS
  afterEach(() => {
    if (savedToolSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = savedToolSearch
    if (savedReminders === undefined) delete process.env.CLAUDIN_DISABLE_TOOL_REMINDERS
    else process.env.CLAUDIN_DISABLE_TOOL_REMINDERS = savedReminders
  })

  test('a successful result carries the note, asked for once', async () => {
    const { probe, texts } = await run('ok', () => ({ message: NOTE }))
    expect(texts).toContain('ran ok')
    expect(texts).toContain(`<system-reminder>\\n${NOTE}`)
    expect(probe).toEqual({ advised: 1, ran: 1 })
  })

  test('a failing call carries the note too', async () => {
    // A test run with failures exits non-zero, and Bash reports that as an
    // error: the note has to survive the error path or it would miss the
    // commonest case.
    const { probe, texts } = await run('throw', () => ({ message: NOTE }))
    expect(texts).toContain('the command failed')
    expect(texts).toContain('"is_error":true')
    expect(texts).toContain(NOTE)
    expect(probe.advised).toBe(1)
  })

  test('no advice, no note', async () => {
    const { texts } = await run('ok', () => null)
    expect(texts).not.toContain('<system-reminder>')
  })

  test('a throwing advise costs the call nothing', async () => {
    const { probe, texts } = await run('ok', () => {
      throw new Error('advise broke')
    })
    expect(probe.ran).toBe(1)
    expect(texts).toContain('ran ok')
    expect(texts).not.toContain('<system-reminder>')
  })

  test('the tool-reminder killswitch silences it', async () => {
    process.env.CLAUDIN_DISABLE_TOOL_REMINDERS = '1'
    const { texts } = await run('ok', () => ({ message: NOTE }))
    expect(texts).not.toContain(NOTE)
  })

  test('a deferred tool it points at gets the ToolSearch call that loads it', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const { texts } = await run('ok', () => ({ message: NOTE, suggests: 'DeferredTarget' }))
    expect(texts).toContain('DeferredTarget is deferred: load it first with ToolSearch \\"select:DeferredTarget\\".')
  })

  test('a tool other than Bash keeps its note whatever its result says', async () => {
    const { texts } = await run('ok', () => ({ message: NOTE }))
    expect(texts).toContain(NOTE)
    expect(adviceNoteAfterCall({ name: 'AdviceProbe' }, { command: 'cat a' }, { creditedFiles: ['/a'] }, NOTE)).toBe(NOTE)
  })

  test('once that tool is loaded, the load line goes', async () => {
    process.env.ENABLE_TOOL_SEARCH = 'true'
    const loaded = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search',
            content: [{ type: 'tool_reference', tool_name: 'DeferredTarget' }],
          },
        ],
      },
    }
    const { texts } = await run('ok', () => ({ message: NOTE, suggests: 'DeferredTarget' }), [loaded])
    expect(texts).toContain(NOTE)
    expect(texts).not.toContain('is deferred: load it first')
  })
})

// CLAUDIN_BASH_READ_CREDIT: a Bash `cat` whose every file counted as read
// (`creditedFiles`, BashTool/creditShownFiles.ts) keeps no note sending the
// model to Read them again (redirectLanes.ts, isReadAdviceMoot).
describe('adviceNoteAfterCall — a Bash read the credit already counted', () => {
  const BASH = { name: 'Bash' }
  const READ_NOTE = '\n\n<system-reminder>\nThis command only reads or searches files…\n</system-reminder>'
  let dir: string
  let a: string
  let b: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'advice-credit-'))
    a = join(dir, 'a.ts')
    b = join(dir, 'b.ts')
    writeFileSync(a, 'export const a = 1\nexport const aa = 2\n')
    writeFileSync(b, 'export const b = 1\nexport const bb = 2\n')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('every file it names was credited: the note goes', () => {
    expect(
      adviceNoteAfterCall(BASH, { command: `cat ${a} ${b}` }, { stdout: '', creditedFiles: [a, b] }, READ_NOTE),
    ).toBeNull()
  })

  test('a file it names was not: the note stands', () => {
    expect(
      adviceNoteAfterCall(BASH, { command: `cat ${a} ${b}` }, { stdout: '', creditedFiles: [a] }, READ_NOTE),
    ).toBe(READ_NOTE)
  })

  test('no creditedFiles — the credit is off, or showed nothing whole: the note stands', () => {
    expect(adviceNoteAfterCall(BASH, { command: `cat ${a} ${b}` }, { stdout: '' }, READ_NOTE)).toBe(READ_NOTE)
  })

  test('no note, nothing to drop', () => {
    expect(adviceNoteAfterCall(BASH, { command: `cat ${a}` }, { creditedFiles: [a] }, null)).toBeNull()
  })

  // Only Bash's result carries a read credit. The same input and result that
  // make Bash's note moot leave any other tool's note standing.
  test('the credit drops the note of Bash only', () => {
    const input = { command: `cat ${a} ${b}` }
    const output = { stdout: '', creditedFiles: [a, b] }
    expect(adviceNoteAfterCall(BASH, input, output, READ_NOTE)).toBeNull()
    expect(adviceNoteAfterCall({ name: 'AdviceProbe' }, input, output, READ_NOTE)).toBe(READ_NOTE)
  })

  /** A tool named Bash whose result carries `creditedFiles`, run through the real loop. */
  async function runBash(creditedFiles: string[]): Promise<string> {
    const tool = buildTool({
      name: 'Bash',
      maxResultSizeChars: 10_000,
      async description() {
        return 'bash probe'
      },
      async prompt() {
        return 'bash probe'
      },
      get inputSchema() {
        return z.strictObject({ command: z.string() })
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async checkPermissions(input: { command: string }) {
        return { behavior: 'allow' as const, updatedInput: input }
      },
      advise: () => ({ message: 'This command only reads or searches files, and Read does that without the shell:' }),
      async call() {
        return { data: { stdout: 'printed', creditedFiles } }
      },
      mapToolResultToToolResultBlockParam(data: { stdout: string }, toolUseID: string) {
        return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data.stdout }
      },
      renderToolUseMessage: () => null,
    })
    const toolUse = { type: 'tool_use' as const, id: 'toolu_bash', name: 'Bash', input: { command: `cat ${a} ${b}` } }
    const assistant = {
      type: 'assistant',
      uuid: 'a-bash',
      message: { id: 'msg_bash', role: 'assistant', content: [toolUse] },
    }
    const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
    const results: unknown[] = []
    for await (const update of runToolUse(toolUse as never, assistant as never, allow, contextFor([tool]))) {
      results.push(update)
    }
    return JSON.stringify(results)
  }

  test('in the tool loop: the result goes out without the note once every file counted', async () => {
    const counted = await runBash([a, b])
    expect(counted).toContain('printed')
    expect(counted).not.toContain('only reads or searches files')
    expect(await runBash([a])).toContain('only reads or searches files')
  })
})
