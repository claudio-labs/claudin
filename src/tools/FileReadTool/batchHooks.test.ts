// Hooks around a Read, driven the way the agent loop drives them: through
// runToolUse (src/agent/tools/toolExecution.ts), with real command hooks held
// in the app state's session hooks — the store getHooksConfig merges for the
// running agent (src/platform/lifecycleHooks/matching.ts).
//
// Each hook is a small bash script that appends the JSON it was handed to a
// log and answers by the path it sees, so a test reads exactly what a hook
// author's script would: the tool_input, and for PostToolUse the
// tool_response.
//
// CLAUDIN_SIMPLE (bare mode) turns every hook off (executeHooks.ts), and
// useFileReadEnv sets it for the FileReadTool suites. This file needs the
// hooks, so each describe clears it and hands it back (useHooksEnabled).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runToolUse } from 'src/agent/tools/toolExecution.js'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import type { HookEvent } from 'src/platform/entrypoints/agentSdkTypes.js'
import {
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
} from 'src/platform/lifecycleHooks/hooks.js'
import type { SessionHooksState } from 'src/platform/lifecycleHooks/sessionHooks.js'
import type { PermissionRequestResult } from 'src/shared/types/hooks.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { userWithToolResult } from 'src/tools/FileReadTool/__test-helpers__/contextManagementFixtures.js'
import {
  fixtureDir,
  makeContext,
  SAMPLE_TS,
  setContextMessages,
  useFileReadEnv,
  writeFixture,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'
import { importWithReadMulti } from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'
import { _setMitigationModelResolverForTesting } from 'src/tools/FileReadTool/resultContent.js'

useFileReadEnv()

type ReadModule = typeof import('src/tools/FileReadTool/FileReadTool.js')
type SchemasModule = typeof import('src/tools/FileReadTool/schemas.js')
type ReadTool = ReadModule['FileReadTool']

const MODULE = 'src/tools/FileReadTool/FileReadTool.js'
const SCHEMAS = 'src/tools/FileReadTool/schemas.js'
const AGENT = 'read-hooks-test-agent'

let ReadOn: ReadTool
let ReadOff: ReadTool
let priorInteractive = false
let priorMacro: unknown

/**
 * One arm of the flag, whole: a tool module takes its input schema from the
 * process-wide schemas.js, which read the flag when the process loaded it,
 * so each arm carries the schema its own flag state makes.
 */
async function readArm(on: boolean): Promise<ReadTool> {
  const { FileReadTool } = await importWithReadMulti<ReadModule>(MODULE, on)
  const { inputSchema } = await importWithReadMulti<SchemasModule>(SCHEMAS, on)
  return { ...FileReadTool, inputSchema: inputSchema() } as ReadTool
}

beforeAll(async () => {
  ReadOn = await readArm(true)
  ReadOff = await readArm(false)
  // Hooks run without a trust prompt only in a non-interactive session
  // (shouldSkipHookDueToTrust) — pinned rather than trusted to the default.
  priorInteractive = getIsInteractive()
  setIsInteractive(false)
  // The once-per-agent mitigation reminder would land on whichever read
  // comes first; an exempt model keeps every result comparable.
  _setMitigationModelResolverForTesting(() => 'claude-opus-5-5')
  // A read permission check outside the working directories reaches the
  // build-time MACRO.VERSION (checkReadableInternalPath → bundled skills).
  priorMacro = (globalThis as Record<string, unknown>).MACRO
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
})

afterAll(() => {
  setIsInteractive(priorInteractive)
  _setMitigationModelResolverForTesting(undefined)
  if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
  else (globalThis as Record<string, unknown>).MACRO = priorMacro
})

/**
 * Called at the top of each describe: useFileReadEnv sets CLAUDIN_SIMPLE for
 * the whole file, and bare mode runs no hook. Clearing it in a describe's
 * hooks nests them inside the file's, so the file's own afterAll still
 * restores the variable last — file-level afterAll hooks run in the order
 * they were registered, and a file-level reset here would run after it.
 */
function useHooksEnabled(): void {
  beforeAll(() => {
    delete process.env.CLAUDIN_SIMPLE
  })
  afterAll(() => {
    process.env.CLAUDIN_SIMPLE = '1'
  })
}

// ---------------------------------------------------------------------------
// Hooks as a hook author writes them
// ---------------------------------------------------------------------------

type HookEntry = {
  hook_event_name: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response?: Record<string, unknown>
  error?: string
}

let scriptSeq = 0

/**
 * A command hook: a bash script that logs the JSON it receives, one line per
 * run, then runs `answer` — shell that may print a JSON decision, with the
 * input in `$input`. Returns the command to configure and the log to read.
 */
function commandHook(answer = ''): { command: string; log: string } {
  const n = ++scriptSeq
  const log = join(fixtureDir(), `hook-${n}.log`)
  const script = join(fixtureDir(), `hook-${n}.sh`)
  writeFileSync(
    script,
    ['#!/bin/bash', 'input=$(cat)', `printf '%s\\n' "$input" >> '${log}'`, answer, ''].join('\n'),
  )
  return { command: `bash '${script}'`, log }
}

/** The runs a hook logged, in order. */
function runsOf(log: string): HookEntry[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as HookEntry)
}

/** Prints a PreToolUse decision for any path ending in `.secret`. */
function denySecret(reason = 'secret files are off limits'): string {
  return `case "$input" in *'.secret"'*) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"${reason}"}}' ;; esac`
}

type ConfiguredHook = { matcher?: string; command: string; if?: string }

type TestAppState = {
  toolPermissionContext: ToolPermissionContext
  sessionHooks: SessionHooksState
}

function hooked(events: Partial<Record<HookEvent, ConfiguredHook[]>>): TestAppState {
  const hooks: Record<string, unknown> = {}
  for (const [event, list] of Object.entries(events)) {
    hooks[event] = (list ?? []).map(({ matcher = 'Read', command, if: condition }) => ({
      matcher,
      hooks: [
        {
          hook: {
            type: 'command',
            command,
            timeout: 20,
            ...(condition !== undefined && { if: condition }),
          },
        },
      ],
    }))
  }
  return {
    toolPermissionContext: getEmptyToolPermissionContext(),
    sessionHooks: new Map([[AGENT, { hooks }]]) as SessionHooksState,
  }
}

// ---------------------------------------------------------------------------
// The agent loop, minus the model
// ---------------------------------------------------------------------------

let callSeq = 0

function toolContext(tool: ReadTool, state: TestAppState, maxTokens?: number): ToolUseContext {
  const ctx = makeContext(maxTokens === undefined ? {} : { fileReadingLimits: { maxTokens } })
  Object.assign(ctx, {
    agentId: AGENT,
    messages: [],
    nestedMemoryAttachmentTriggers: new Set<string>(),
    getAppState: () => state,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    options: {
      tools: [tool],
      mcpClients: [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-opus-5-5',
    },
  })
  return ctx
}

type AskedPermission = { input: Record<string, unknown>; force?: { behavior: string; message?: string } }

/** A permission prompt that answers `behavior` and records every question. */
function permissionPrompt(behavior: 'allow' | 'deny' = 'allow') {
  const asked: AskedPermission[] = []
  const canUseTool = async (
    _tool: unknown,
    input: Record<string, unknown>,
    _ctx: unknown,
    _assistant: unknown,
    _id: unknown,
    force?: { behavior: string; message?: string },
  ) => {
    asked.push({ input, ...(force !== undefined && { force }) })
    return behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'denied at the prompt', decisionReason: { type: 'other', reason: 'test' } }
  }
  return { asked, canUseTool }
}

type ToolResultSeen = { text: string; isError: boolean }

function toolResultOf(updates: unknown[]): ToolResultSeen | undefined {
  for (const update of updates) {
    const message = (update as { message?: { type?: string; message?: { content?: unknown } } }).message
    if (message?.type !== 'user' || !Array.isArray(message.message?.content)) continue
    for (const block of message.message.content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result') continue
      const content = block.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as { text?: string }[]).map(b => b.text ?? '').join('')
            : ''
      return { text, isError: block.is_error === true }
    }
  }
  return undefined
}

type RunOptions = {
  prompt?: ReturnType<typeof permissionPrompt>
  /** A context to run in again — its readFileState, its transcript. */
  ctx?: ToolUseContext
  maxTokens?: number
}

async function runRead(
  tool: ReadTool,
  input: Record<string, unknown>,
  state: TestAppState,
  options: RunOptions = {},
): Promise<{
  ctx: ToolUseContext
  id: string
  result: ToolResultSeen | undefined
  asked: AskedPermission[]
}> {
  const { prompt = permissionPrompt() } = options
  const n = ++callSeq
  const id = `toolu_read_hooks_${n}`
  const toolUse = { type: 'tool_use' as const, id, name: 'Read', input }
  const assistant = {
    type: 'assistant',
    uuid: `assistant-read-hooks-${n}`,
    message: { id: `msg_read_hooks_${n}`, role: 'assistant', content: [toolUse] },
  }
  const ctx = options.ctx ?? toolContext(tool, state, options.maxTokens)
  Object.assign(ctx, { getAppState: () => state, options: { ...ctx.options, tools: [tool] } })
  const updates: unknown[] = []
  for await (const update of runToolUse(toolUse as never, assistant as never, prompt.canUseTool as never, ctx)) {
    updates.push(update)
  }
  return { ctx, id, result: toolResultOf(updates), asked: prompt.asked }
}

// ---------------------------------------------------------------------------
// A single Read — pinned before the batch had hooks of its own
// ---------------------------------------------------------------------------

describe('a single Read runs each hook once, on its own input', () => {
  useHooksEnabled()

  for (const [arm, tool] of [
    ['flag off', () => ReadOff],
    ['flag on', () => ReadOn],
  ] as const) {
    test(`${arm}: PreToolUse sees the file_path, PostToolUse the input and the Read's own response`, async () => {
      const a = writeFixture(`single-${arm.replace(' ', '-')}.ts`, SAMPLE_TS)
      const pre = commandHook()
      const post = commandHook()
      const state = hooked({ PreToolUse: [pre], PostToolUse: [post] })
      const { result } = await runRead(tool(), { file_path: a }, state)
      expect(result?.isError).toBe(false)
      expect(runsOf(pre.log).map(r => [r.hook_event_name, r.tool_name, r.tool_input])).toEqual([
        ['PreToolUse', 'Read', { file_path: a }],
      ])
      const [postRun, ...more] = runsOf(post.log)
      expect(more).toEqual([])
      expect(postRun?.tool_input).toEqual({ file_path: a })
      expect(postRun?.tool_response?.type).toBe('text')
      expect((postRun?.tool_response?.file as { filePath?: string }).filePath).toBe(a)
    })
  }

  test("a PreToolUse deny refuses the Read with the hook's reason", async () => {
    const secret = writeFixture('single.secret', 'TOKEN=1\n')
    const pre = commandHook(denySecret())
    const post = commandHook()
    const { result, ctx } = await runRead(ReadOff, { file_path: secret }, hooked({ PreToolUse: [pre], PostToolUse: [post] }))
    expect(result).toEqual({ text: 'secret files are off limits', isError: true })
    expect(ctx.readFileState.has(secret)).toBe(false)
    expect(runsOf(post.log)).toEqual([])
  })

  test('a Read that fails runs PostToolUseFailure with its input and error', async () => {
    const missing = join(fixtureDir(), 'single-missing.ts')
    const failure = commandHook()
    const post = commandHook()
    const { result } = await runRead(
      ReadOff,
      { file_path: missing },
      hooked({ PostToolUse: [post], PostToolUseFailure: [failure] }),
    )
    expect(result?.isError).toBe(true)
    expect(runsOf(post.log)).toEqual([])
    const runs = runsOf(failure.log)
    expect(runs.map(r => r.tool_input)).toEqual([{ file_path: missing }])
    expect(runs[0]?.error).toContain('File does not exist')
  })

  test('PermissionRequest hooks get the single input and decide for it', async () => {
    const a = writeFixture('single-permission.ts', SAMPLE_TS)
    const hook = commandHook(
      `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not this one"}}}'`,
    )
    const ctx = toolContext(ReadOff, hooked({ PermissionRequest: [hook] }))
    const decisions: PermissionRequestResult[] = []
    for await (const result of executePermissionRequestHooks('Read', 'toolu_permission_single', { file_path: a }, ctx)) {
      if (result.permissionRequestResult) decisions.push(result.permissionRequestResult)
    }
    expect(decisions).toEqual([{ behavior: 'deny', message: 'not this one' }])
    expect(runsOf(hook.log).map(r => r.tool_input)).toEqual([{ file_path: a }])
  })

  test('PermissionDenied hooks get the single input, and their retry comes back', async () => {
    const a = writeFixture('single-denied.ts', SAMPLE_TS)
    const hook = commandHook(
      `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}'`,
    )
    const ctx = toolContext(ReadOff, hooked({ PermissionDenied: [hook] }))
    let retry = false
    for await (const result of executePermissionDeniedHooks(
      'Read',
      'toolu_denied_single',
      { file_path: a },
      'the classifier said no',
      ctx,
    )) {
      if (result.retry) retry = true
    }
    expect(retry).toBe(true)
    expect(runsOf(hook.log).map(r => r.tool_input)).toEqual([{ file_path: a }])
  })
})

// ---------------------------------------------------------------------------
// A batch Read — to its hooks, one Read per file (and symbol)
// ---------------------------------------------------------------------------

const OTHER_TS = ['export function gamma(): string {', "  return 'g'", '}'].join('\n')

/** The inputs a hook was run with, in a stable order: units run at once. */
function inputsSeen(log: string): Record<string, unknown>[] {
  return sortInputs(runsOf(log).map(r => r.tool_input))
}

function sortInputs(inputs: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...inputs].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
}

function preDecision(decision: 'allow' | 'ask', reason: string, extra = ''): string {
  return `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}","permissionDecisionReason":"${reason}"${extra}}}`
}

describe('a batch Read runs its hooks once per file, never on the batch', () => {
  useHooksEnabled()

  test('PreToolUse gets the input a Read of each file carries — never file_paths', async () => {
    const a = writeFixture('batch-pre-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-pre-b.ts', OTHER_TS)
    const pre = commandHook()
    const { result } = await runRead(
      ReadOn,
      { file_paths: [a, b], view: 'outline' },
      hooked({ PreToolUse: [pre] }),
    )
    expect(result?.isError).toBe(false)
    // Exactly one run per file: no run on the batch as well.
    expect(inputsSeen(pre.log)).toEqual(
      sortInputs([
        { file_path: a, view: 'outline' },
        { file_path: b, view: 'outline' },
      ]),
    )
  })

  test('a symbol list is one Read per file and symbol, each symbol a string', async () => {
    const a = writeFixture('batch-sym-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-sym-b.ts', OTHER_TS)
    const pre = commandHook()
    await runRead(ReadOn, { file_paths: [a, b], symbol: ['alpha', 'gamma'] }, hooked({ PreToolUse: [pre] }))
    expect(inputsSeen(pre.log)).toEqual(
      sortInputs([
        { file_path: a, symbol: 'alpha' },
        { file_path: a, symbol: 'gamma' },
        { file_path: b, symbol: 'alpha' },
        { file_path: b, symbol: 'gamma' },
      ]),
    )
    // One file with several symbols is a batch of its own.
    const one = commandHook()
    await runRead(ReadOn, { file_path: a, symbol: ['alpha', 'beta'] }, hooked({ PreToolUse: [one] }))
    expect(inputsSeen(one.log)).toEqual(
      sortInputs([
        { file_path: a, symbol: 'alpha' },
        { file_path: a, symbol: 'beta' },
      ]),
    )
  })

  test("a deny for one file denies the batch, naming the file and its hook's reason", async () => {
    const a = writeFixture('batch-deny-a.ts', SAMPLE_TS)
    const secret = writeFixture('batch-deny-b.secret', 'TOKEN=1\n')
    const pre = commandHook(denySecret())
    const post = commandHook()
    const prompt = permissionPrompt()
    const { result, ctx } = await runRead(
      ReadOn,
      { file_paths: [a, secret] },
      hooked({ PreToolUse: [pre], PostToolUse: [post] }),
      { prompt },
    )
    expect(result).toEqual({
      text:
        'PreToolUse:Read hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
        `- ${secret}: secret files are off limits`,
      isError: true,
    })
    // Nothing was read, nothing asked, and nothing ran after it.
    expect(ctx.readFileState.has(a)).toBe(false)
    expect(prompt.asked).toEqual([])
    expect(runsOf(post.log)).toEqual([])
  })

  test('an ask from the hooks is ONE ask, naming the files that asked', async () => {
    const x = writeFixture('batch-ask-x-ask.ts', SAMPLE_TS)
    const b = writeFixture('batch-ask-b.ts', OTHER_TS)
    const y = writeFixture('batch-ask-y-ask.ts', OTHER_TS)
    const pre = commandHook(`case "$input" in *'ask.ts"'*) printf '%s' '${preDecision('ask', 'check this one')}' ;; esac`)
    const prompt = permissionPrompt('allow')
    const { result } = await runRead(ReadOn, { file_paths: [x, b, y] }, hooked({ PreToolUse: [pre] }), { prompt })
    expect(prompt.asked).toHaveLength(1)
    expect(prompt.asked[0]?.force?.behavior).toBe('ask')
    expect(prompt.asked[0]?.force?.message).toBe(
      `PreToolUse:Read hook asks before part of this call:\n- ${x}: check this one\n- ${y}: check this one`,
    )
    // Approved once, the whole batch runs.
    expect(result?.isError).toBe(false)
    for (const file of [x, b, y]) expect(result?.text).toContain(`==> ${file} <==`)
  })

  test('an allow for every file runs the batch without asking', async () => {
    const a = writeFixture('batch-allow-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-allow-b.ts', OTHER_TS)
    const pre = commandHook(`printf '%s' '${preDecision('allow', 'fine')}'`)
    const prompt = permissionPrompt('deny')
    const { result } = await runRead(ReadOn, { file_paths: [a, b] }, hooked({ PreToolUse: [pre] }), { prompt })
    expect(prompt.asked).toEqual([])
    expect(result?.isError).toBe(false)
    for (const file of [a, b]) expect(result?.text).toContain(`==> ${file} <==`)
  })

  test("a file's updatedInput reads the rewritten path in that file's place", async () => {
    const old = writeFixture('batch-rewrite-old.ts', SAMPLE_TS)
    const moved = writeFixture('batch-rewrite-new.ts', OTHER_TS)
    const b = writeFixture('batch-rewrite-b.ts', SAMPLE_TS)
    const pre = commandHook(
      `case "$input" in *'old.ts"'*) printf '%s' '${preDecision('allow', 'moved', `,"updatedInput":{"file_path":"${moved}"}`)}' ;; esac`,
    )
    const post = commandHook()
    const prompt = permissionPrompt('allow')
    const { result, ctx } = await runRead(
      ReadOn,
      { file_paths: [old, b] },
      hooked({ PreToolUse: [pre], PostToolUse: [post] }),
      { prompt },
    )
    expect(result?.isError).toBe(false)
    expect(result?.text).toContain(`==> ${moved} <==`)
    expect(result?.text).toContain(`==> ${b} <==`)
    expect(result?.text).not.toContain(`==> ${old} <==`)
    expect(ctx.readFileState.has(moved)).toBe(true)
    expect(ctx.readFileState.has(old)).toBe(false)
    // b's hook decided nothing, so the batch took the ordinary permission
    // check — asked about the batch as it will now run.
    expect(prompt.asked.map(a => a.input.file_paths)).toEqual([[moved, b]])
    // And the hooks after it saw the file that was read.
    expect(inputsSeen(post.log)).toEqual(sortInputs([{ file_path: moved }, { file_path: b }]))
  })

  test('a change one file of a batch cannot carry is refused, naming that file', async () => {
    const a = writeFixture('batch-carry-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-carry-b.ts', OTHER_TS)
    const pre = commandHook(
      `case "$input" in *'carry-a.ts"'*) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"file_path":"${a}","view":"outline"}}}' ;; esac`,
    )
    const { result, ctx } = await runRead(ReadOn, { file_paths: [a, b] }, hooked({ PreToolUse: [pre] }))
    expect(result).toEqual({
      text: `A hook changed the Read of ${a} in a way a batch cannot carry for one file — Read that file in a call of its own.`,
      isError: true,
    })
    expect(ctx.readFileState.has(b)).toBe(false)
  })

  test('PostToolUse runs once per file shown, with its input and its own response', async () => {
    const a = writeFixture('batch-post-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-post-b.ts', OTHER_TS)
    const post = commandHook()
    const { result } = await runRead(ReadOn, { file_paths: [a, b] }, hooked({ PostToolUse: [post] }))
    expect(result?.isError).toBe(false)
    const runs = runsOf(post.log).sort((x, y) =>
      String(x.tool_input.file_path).localeCompare(String(y.tool_input.file_path)),
    )
    expect(runs.map(r => r.tool_input)).toEqual([{ file_path: a }, { file_path: b }])
    for (const [run, file, content] of [
      [runs[0], a, SAMPLE_TS],
      [runs[1], b, OTHER_TS],
    ] as const) {
      expect(run?.tool_response?.type).toBe('text')
      const shown = run?.tool_response?.file as { filePath?: string; content?: string }
      expect(shown.filePath).toBe(file)
      expect(shown.content).toBe(content)
    }
  })

  test('a stubbed, absent or unshown file gets no PostToolUse; a failed one gets PostToolUseFailure', async () => {
    const a = writeFixture('batch-stub-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-stub-b.ts', OTHER_TS)
    const missing = join(fixtureDir(), 'batch-stub-missing.ts')
    // Each fits what one Read may return; together they outgrow the batch's
    // budget, so the last ones are named and not shown.
    const budget = [0, 1, 2, 3, 4].map(i =>
      writeFixture(
        `batch-stub-budget-${i}.txt`,
        Array.from({ length: 30 }, (_, n) => `budget${i}-${n}-`.padEnd(44, 'x')).join('\n'),
      ),
    )
    // A prior Read of `a` whose tool_result is still in the transcript: the
    // batch hands back the dedup stub for it.
    const first = await runRead(ReadOn, { file_path: a }, hooked({}), { maxTokens: 1_500 })
    setContextMessages(first.ctx, [userWithToolResult(first.id, 'the body the stub points at')])

    const post = commandHook()
    const failure = commandHook()
    const { result } = await runRead(
      ReadOn,
      { file_paths: [a, b, missing, ...budget] },
      hooked({ PostToolUse: [post], PostToolUseFailure: [failure] }),
      { ctx: first.ctx },
    )
    const text = result?.text ?? ''
    expect(text).toContain(`==> ${a} <==\nFile unchanged since last read`)
    const shown = budget.filter(file => text.includes(`==> ${file} <==`))
    const unshown = budget.filter(file => !shown.includes(file))
    expect(unshown.length).toBeGreaterThan(0)
    expect(text).toContain(`Not shown — over the 2k tokens one Read returns: ${unshown.join(', ')}.`)
    expect(inputsSeen(post.log)).toEqual(
      sortInputs([b, ...shown].map(file => ({ file_path: file }))),
    )
    const failed = runsOf(failure.log)
    expect(failed.map(r => r.tool_input)).toEqual([{ file_path: missing }])
    expect(failed[0]?.error).toContain('File does not exist')
  })

  test('a symbol a file does not have runs PostToolUseFailure for that file and symbol', async () => {
    const a = writeFixture('batch-miss-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-miss-b.ts', OTHER_TS)
    const post = commandHook()
    const failure = commandHook()
    await runRead(
      ReadOn,
      { file_paths: [a, b], symbol: 'gamma' },
      hooked({ PostToolUse: [post], PostToolUseFailure: [failure] }),
    )
    expect(inputsSeen(post.log)).toEqual([{ file_path: b, symbol: 'gamma' }])
    const failed = runsOf(failure.log)
    expect(failed.map(r => r.tool_input)).toEqual([{ file_path: a, symbol: 'gamma' }])
    expect(failed[0]?.error).toContain('gamma')
  })

  test('a batch that fails as a whole runs PostToolUseFailure once per file', async () => {
    const a = writeFixture('batch-fail-a.ts', SAMPLE_TS)
    const b = writeFixture('batch-fail-b.ts', OTHER_TS)
    const failing = {
      ...ReadOn,
      async call() {
        throw new Error('the disk went away')
      },
    } as unknown as ReadTool
    const failure = commandHook()
    const { result } = await runRead(failing, { file_paths: [a, b] }, hooked({ PostToolUseFailure: [failure] }))
    expect(result?.isError).toBe(true)
    const failed = runsOf(failure.log)
    expect(sortInputs(failed.map(r => r.tool_input))).toEqual(sortInputs([{ file_path: a }, { file_path: b }]))
    for (const run of failed) expect(run.error).toContain('the disk went away')
  })

  test("an if condition selects the hook for the file it names, and only that file's run", async () => {
    const a = writeFixture('batch-if-a.ts', SAMPLE_TS)
    const secret = writeFixture('batch-if-b.secret', 'TOKEN=1\n')
    const pre = { ...commandHook(denySecret()), if: 'Read(*.secret)' }
    const { result } = await runRead(ReadOn, { file_paths: [a, secret] }, hooked({ PreToolUse: [pre] }))
    expect(result?.isError).toBe(true)
    expect(result?.text).toContain(`- ${secret}: secret files are off limits`)
    expect(inputsSeen(pre.log)).toEqual([{ file_path: secret }])
  })
})

describe('the permission hooks of a batch Read decide per file', () => {
  useHooksEnabled()

  const PERMISSION_DENY_SECRET = `case "$input" in *'.secret"'*) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no secrets"}}}' ;; *) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ;; esac`

  async function permissionDecisions(input: Record<string, unknown>, hook: { command: string }) {
    const ctx = toolContext(ReadOn, hooked({ PermissionRequest: [hook] }))
    const decisions: PermissionRequestResult[] = []
    for await (const result of executePermissionRequestHooks('Read', 'toolu_permission_batch', input, ctx)) {
      if (result.permissionRequestResult) decisions.push(result.permissionRequestResult)
    }
    return decisions
  }

  test('PermissionRequest: a deny for one file is the one decision, naming it', async () => {
    const a = writeFixture('permission-a.ts', SAMPLE_TS)
    const secret = writeFixture('permission-b.secret', 'TOKEN=1\n')
    const hook = commandHook(PERMISSION_DENY_SECRET)
    expect(await permissionDecisions({ file_paths: [a, secret] }, hook)).toEqual([
      {
        behavior: 'deny',
        message:
          'PermissionRequest hook denied part of this call, so none of it ran — leave these out to run the rest:\n' +
          `- ${secret}: no secrets`,
      },
    ])
    expect(inputsSeen(hook.log)).toEqual(sortInputs([{ file_path: a }, { file_path: secret }]))
  })

  test('PermissionRequest: an allow from every file allows the call', async () => {
    const a = writeFixture('permission-ok-a.ts', SAMPLE_TS)
    const b = writeFixture('permission-ok-b.ts', OTHER_TS)
    const hook = commandHook(PERMISSION_DENY_SECRET)
    expect(await permissionDecisions({ file_paths: [a, b] }, hook)).toEqual([{ behavior: 'allow' }])
  })

  test('PermissionDenied: each file hears of the denial with its own input', async () => {
    const a = writeFixture('denied-a.ts', SAMPLE_TS)
    const b = writeFixture('denied-b.ts', OTHER_TS)
    const hook = commandHook()
    const ctx = toolContext(ReadOn, hooked({ PermissionDenied: [hook] }))
    for await (const _ of executePermissionDeniedHooks(
      'Read',
      'toolu_denied_batch',
      { file_paths: [a, b] },
      'the classifier said no',
      ctx,
    )) {
      // drained for the hooks' side effects
    }
    expect(inputsSeen(hook.log)).toEqual(sortInputs([{ file_path: a }, { file_path: b }]))
  })
})
