// runTools, wired through the real tool loop: the calls of one response run in
// order, and under CLAUDIN_RESPONSE_CHAINS the ones that run or ship code are
// skipped once an earlier call failed (responseChain.ts). Probe tools carry the
// real tools' names, since the chain decides by name.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runTools } from 'src/agent/tools/toolOrchestration.js'
import {
  buildTool,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'

const FLAG = 'CLAUDIN_RESPONSE_CHAINS'
const COMMIT_FLAG = 'CLAUDIN_ONE_CALL_COMMIT'
const THEN_FLAG = 'CLAUDIN_EDIT_THEN'
const priorFlag = process.env[FLAG]
const priorCommitFlag = process.env[COMMIT_FLAG]
const priorThenFlag = process.env[THEN_FLAG]

afterEach(() => {
  if (priorFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = priorFlag
  if (priorCommitFlag === undefined) delete process.env[COMMIT_FLAG]
  else process.env[COMMIT_FLAG] = priorCommitFlag
  if (priorThenFlag === undefined) delete process.env[THEN_FLAG]
  else process.env[THEN_FLAG] = priorThenFlag
})

/** Every call that reached `call()`, in the order it ran — a failed one included. */
type Ran = string[]

function probe<S extends z.ZodType<Record<string, unknown>>>(opts: {
  name: string
  aliases?: string[]
  schema: S
  readOnly: (input: z.infer<S>) => boolean
  /** Defaults to readOnly; the real Git is never concurrency-safe. */
  concurrencySafe?: (input: z.infer<S>) => boolean
  run: (input: z.infer<S>) => unknown
  label: (input: z.infer<S>) => string
  ran: Ran
}) {
  return buildTool({
    name: opts.name,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    maxResultSizeChars: 10_000,
    async description() {
      return opts.name
    },
    async prompt() {
      return opts.name
    },
    get inputSchema() {
      return opts.schema
    },
    isEnabled: () => true,
    isReadOnly: (input: z.infer<S>) => opts.readOnly(input),
    isConcurrencySafe: (input: z.infer<S>) =>
      (opts.concurrencySafe ?? opts.readOnly)(input),
    async checkPermissions(input: z.infer<S>) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
    async call(input: z.infer<S>) {
      opts.ran.push(opts.label(input))
      return { data: opts.run(input) }
    },
    mapToolResultToToolResultBlockParam(_data: unknown, toolUseID: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseID, content: 'done' }
    },
    renderToolUseMessage: () => null,
  })
}

function probeTools(ran: Ran) {
  const edit = probe({
    name: 'Edit',
    schema: z.strictObject({
      file: z.string(),
      ok: z.boolean(),
      then: z.enum(['green', 'red']).optional(),
    }),
    readOnly: () => false,
    run: input => {
      if (!input.ok) throw new Error('String to replace not found in file.')
      if (input.then === undefined) return 'edited'
      // What the real Edit returns when its `then` check ran (editThenShape.ts).
      const exitCode = input.then === 'red' ? 1 : 0
      return { filePath: input.file, then: [{ command: 'bun test', ran: true, exitCode, output: '' }] }
    },
    label: input => `Edit ${input.file}`,
    ran,
  })
  const bash = probe({
    name: 'Bash',
    schema: z.strictObject({ command: z.string() }),
    readOnly: input => {
      if (input.command === 'THROW') throw new Error('unparseable command')
      return input.command.startsWith('cat ')
    },
    concurrencySafe: input => input.command.startsWith('cat '),
    run: input => {
      if (['exit 1', 'cat missing', 'THROW'].includes(input.command)) {
        throw new Error('Exit code 1')
      }
      // `bun test | tail`: the verdict is 0, the base failed (BashTool).
      if (input.command.endsWith('| tail -5')) return { stdout: 'fail', reducedExitCode: 1 }
      return { stdout: 'ok' }
    },
    label: input => `Bash ${input.command}`,
    ran,
  })
  const git = probe({
    name: 'Git',
    schema: z.strictObject({ commands: z.array(z.string()) }),
    readOnly: input =>
      input.commands.every(c => c.startsWith('git status') || c.startsWith('git log')),
    // Like the real Git tool: never concurrency-safe, so even a read-only
    // batch runs alone and reaches the chain's own read-only check.
    concurrencySafe: () => false,
    run: input => {
      if (input.commands.includes('git log --bad-ref')) throw new Error('fatal: bad revision')
      return 'git done'
    },
    label: input => `Git ${input.commands.join('; ')}`,
    ran,
  })
  const runTests = probe({
    name: 'RunTests',
    aliases: ['Test'],
    schema: z.strictObject({ red: z.boolean() }),
    readOnly: () => false,
    run: input => ({ passed: 1, failed: input.red ? 1 : 0, exitCode: input.red ? 1 : 0 }),
    label: () => 'RunTests',
    ran,
  })
  const read = probe({
    name: 'Read',
    schema: z.strictObject({ file_path: z.string() }),
    readOnly: () => true,
    run: () => 'content',
    label: input => `Read ${input.file_path}`,
    ran,
  })
  return [edit, bash, git, runTests, read]
}

function contextFor(tools: ReturnType<typeof probeTools>): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
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

/** One response of `calls`, run through runTools. */
async function respond(calls: Array<[name: string, input: Record<string, unknown>]>) {
  const ran: Ran = []
  const blocks = calls.map(([name, input], i) => ({
    type: 'tool_use' as const,
    id: `toolu_${i}`,
    name,
    input,
  }))
  const assistant = {
    type: 'assistant',
    uuid: 'a-chain',
    message: { id: 'msg_chain', role: 'assistant', content: blocks },
  }
  const allow = (async (_tool: unknown, input: unknown) => ({
    behavior: 'allow',
    updatedInput: input,
  })) as never
  const results = new Map<string, { text: string; isError: boolean }>()
  for await (const update of runTools(
    blocks as never,
    [assistant] as never,
    allow,
    contextFor(probeTools(ran)),
  )) {
    const message = update.message
    if (message?.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      results.set(block.tool_use_id, {
        text: JSON.stringify(block.content),
        isError: block.is_error === true,
      })
    }
  }
  return { ran, results }
}

describe('runTools — one response, in order', () => {
  test('an edit and the test after it run in the order written', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Edit', { file: 'a.ts', ok: true }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Edit a.ts', 'Bash bun test'])
  })
})

describe('runTools — the response-chain guard (CLAUDIN_RESPONSE_CHAINS=1)', () => {
  test('a test after a failed edit is skipped, naming the edit', async () => {
    process.env[FLAG] = '1'
    const { ran, results } = await respond([
      ['Edit', { file: 'a.ts', ok: false }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Edit a.ts'])
    const skipped = results.get('toolu_1')!
    expect(skipped.isError).toBe(true)
    expect(skipped.text).toContain('Skipped: Edit failed earlier in this response')
    expect(skipped.text).toContain('this Bash call did not run')
  })

  test('off, the test after a failed edit still runs', async () => {
    delete process.env[FLAG]
    process.env[THEN_FLAG] = '0'
    const { ran, results } = await respond([
      ['Edit', { file: 'a.ts', ok: false }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Edit a.ts', 'Bash bun test'])
    expect(results.get('toolu_1')!.text).not.toContain('Skipped')
  })

  test('an edit after a failed edit still runs', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Edit', { file: 'a.ts', ok: false }],
      ['Edit', { file: 'b.ts', ok: true }],
    ])
    expect(ran).toEqual(['Edit a.ts', 'Edit b.ts'])
  })

  test('reads and read-only git still run after a failure; a commit does not', async () => {
    process.env[FLAG] = '1'
    const { ran, results } = await respond([
      ['Bash', { command: 'exit 1' }],
      ['Read', { file_path: '/r/a.ts' }],
      ['Git', { commands: ['git status'] }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).toEqual(['Bash exit 1', 'Read /r/a.ts', 'Git git status'])
    expect(results.get('toolu_3')!.text).toContain('Skipped: Bash(exit 1) failed')
  })

  test('a red RunTests stops the commit after it', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['RunTests', { red: true }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).toEqual(['RunTests'])
  })

  test('a green RunTests lets the commit run', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['RunTests', { red: false }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).toEqual(['RunTests', 'Git git commit -m x'])
  })

  test('a `| tail` that hid a failing test stops the commit after it', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Bash', { command: 'bun test 2>&1 | tail -5' }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).toEqual(['Bash bun test 2>&1 | tail -5'])
  })

  test('a failed read-only command breaks nothing', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Bash', { command: 'cat missing' }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Bash cat missing', 'Bash bun test'])
  })

  test('a failed read-only git breaks nothing', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Git', { commands: ['git log --bad-ref'] }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Git git log --bad-ref', 'Bash bun test'])
  })

  test('a call whose input fails its schema is a write: its error stops the commit', async () => {
    process.env[FLAG] = '1'
    const { ran, results } = await respond([
      ['Bash', { cmd: 'bun test' }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(results.get('toolu_0')!.isError).toBe(true)
    expect(ran).toEqual([])
    expect(results.get('toolu_1')!.text).toContain('Skipped: Bash failed')
  })

  test('a call whose isReadOnly throws is a write: its error stops the commit', async () => {
    process.env[FLAG] = '1'
    const { ran } = await respond([
      ['Bash', { command: 'THROW' }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).not.toContain('Git git commit -m x')
  })

  test('a check called by its alias is judged as the check', async () => {
    process.env[FLAG] = '1'
    const { ran, results } = await respond([
      ['Test', { red: true }],
      ['Git', { commands: ['git commit -m x'] }],
    ])
    expect(ran).toEqual(['RunTests'])
    expect(results.get('toolu_1')!.text).toContain('Skipped: Test failed')
  })
})

describe('runTools — the guard under CLAUDIN_ONE_CALL_COMMIT=1 (then off, so it arms nothing)', () => {
  test('the one-call commit flag arms the guard on its own: a commit after a failed edit is skipped', async () => {
    delete process.env[FLAG]
    process.env[COMMIT_FLAG] = '1'
    process.env[THEN_FLAG] = '0'
    const { ran, results } = await respond([
      ['Edit', { file: 'README.md', ok: false }],
      ['Git', { commands: ['git add README.md', 'git commit -m x', 'git status'] }],
    ])
    expect(ran).toEqual(['Edit README.md'])
    expect(results.get('toolu_1')!.text).toContain('Skipped: Edit failed')
  })

  test('after a clean edit, the commit in the same response runs', async () => {
    delete process.env[FLAG]
    process.env[COMMIT_FLAG] = '1'
    process.env[THEN_FLAG] = '0'
    const { ran } = await respond([
      ['Edit', { file: 'README.md', ok: true }],
      ['Git', { commands: ['git add README.md', 'git commit -m x', 'git status'] }],
    ])
    expect(ran).toEqual(['Edit README.md', 'Git git add README.md; git commit -m x; git status'])
  })
})

describe('runTools — the guard `then` arms (CLAUDIN_EDIT_THEN, on by default)', () => {
  const commit = ['Git', { commands: ['git add README.md', 'git commit -m x', 'git status'] }] as [
    string,
    Record<string, unknown>,
  ]

  test('the default arms the guard: a commit after an edit whose check came back red is skipped', async () => {
    delete process.env[FLAG]
    delete process.env[COMMIT_FLAG]
    delete process.env[THEN_FLAG]
    const { ran, results } = await respond([['Edit', { file: 'README.md', ok: true, then: 'red' }], commit])
    expect(ran).toEqual(['Edit README.md'])
    expect(results.get('toolu_1')!.text).toContain('Skipped: Edit failed')
  })

  test('the default arms the guard for any failure: a test after a failed edit is skipped', async () => {
    delete process.env[FLAG]
    delete process.env[COMMIT_FLAG]
    delete process.env[THEN_FLAG]
    const { ran } = await respond([
      ['Edit', { file: 'a.ts', ok: false }],
      ['Bash', { command: 'bun test' }],
    ])
    expect(ran).toEqual(['Edit a.ts'])
  })

  test('after a green check, the commit in the same response runs', async () => {
    delete process.env[FLAG]
    delete process.env[COMMIT_FLAG]
    delete process.env[THEN_FLAG]
    const { ran } = await respond([['Edit', { file: 'README.md', ok: true, then: 'green' }], commit])
    expect(ran).toEqual(['Edit README.md', 'Git git add README.md; git commit -m x; git status'])
  })

  test('off (=0), a red check stops nothing', async () => {
    delete process.env[FLAG]
    delete process.env[COMMIT_FLAG]
    process.env[THEN_FLAG] = '0'
    const { ran } = await respond([['Edit', { file: 'README.md', ok: true, then: 'red' }], commit])
    expect(ran).toEqual(['Edit README.md', 'Git git add README.md; git commit -m x; git status'])
  })
})
