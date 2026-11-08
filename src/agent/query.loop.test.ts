/**
 * Characterization of the agent loop (src/agent/query.ts): every way a turn
 * ends, every way it continues, and the model-fallback switch, pinned before
 * the fallback hold changes them.
 *
 * Only the model is fake, injected through `deps.callModel` the way
 * __testutils__/loopHarness.ts does it; tool execution, the stop hooks, the
 * attachment pipeline and the message queue are the production code. No
 * `mock.module`: the process-global state a test touches (env, the command
 * queue, the lifecycle listener, interactivity) is put back after each test.
 *
 * Not reachable here: the TOKEN_BUDGET block (feature() is false under bun
 * test), the tool-use summary (it calls Haiku over the network) and the late
 * LSP diagnostics tail-wait (it needs a running LSP server).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import { isAutoCompactEnabled } from 'src/agent/compact/autoCompact.js'
import {
  getCommandQueue,
  enqueue,
  resetCommandQueue,
} from 'src/agent/messageQueueManager.js'
import {
  createAssistantAPIErrorMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from 'src/agent/messages/constants.js'
import { query, type QueryParams } from 'src/agent/query.js'
import type { QueryDeps } from 'src/agent/query/deps.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import { setCommandLifecycleListener } from 'src/commands/commandLifecycle.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  getIsInteractive,
  setIsInteractive,
} from 'src/platform/bootstrap/state/sessionFlags.js'
import { addFunctionHook, addSessionHook } from 'src/platform/lifecycleHooks/sessionHooks.js'
import { renderModelName } from 'src/providers/model/model.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from 'src/providers/transport/errors.js'
import { type FallbackReason, FallbackTriggeredError } from 'src/providers/transport/withRetry.js'
import {
  _resetFallbackHoldsForTesting,
  FALLBACK_HOLD_MS,
  holdFallback,
} from 'src/providers/model/fallbackHold.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import { ImageSizeError } from 'src/terminal/image/imageValidation.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { buildTool, type Tool, type ToolUseContext, type Tools } from 'src/tools/Tool.js'

const MODEL = 'claude-opus-5-5'
const FALLBACK = 'claude-sonnet-5-5'

// ---------------------------------------------------------------------------
// Process-global state this file reads or writes
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'CLAUDIN_BLOCKING_LIMIT_OVERRIDE',
  'CLAUDIN_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_CACHE_PROFILE',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
] as const
const savedEnv: Record<string, string | undefined> = {}
let savedInteractive = false

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  savedInteractive = getIsInteractive()
})

beforeEach(() => {
  // The summary would call Haiku; bare mode would skip the stop hooks; the
  // compact switches gate the circuit-breaker safety net.
  delete process.env.CLAUDIN_EMIT_TOOL_USE_SUMMARIES
  delete process.env.CLAUDIN_SIMPLE
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE
  process.env.CLAUDIN_CACHE_PROFILE = 'retain'
  _resetCacheProfileForTesting()
  // Hooks run without a trust prompt only in a non-interactive session.
  setIsInteractive(false)
})

afterEach(() => {
  resetCommandQueue()
  setCommandLifecycleListener(null)
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  _resetCacheProfileForTesting()
  resetGlobalConfigForTests()
})

// ---------------------------------------------------------------------------
// The fake model
// ---------------------------------------------------------------------------

type CallArgs = Parameters<QueryDeps['callModel']>[0]
type Block = Record<string, unknown> & { type: string }
type Step = (args: CallArgs, ctx: ToolUseContext) => AsyncGenerator<Message>

let msgCounter = 0

function assistant(
  blocks: Block[],
  opts: { id?: string; usage?: Record<string, number>; extra?: Record<string, unknown> } = {},
): AssistantMessage[] {
  const id = opts.id ?? `msg_q_${++msgCounter}`
  const stopReason = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  return blocks.map(
    block =>
      ({
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: id,
        ...opts.extra,
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            ...opts.usage,
          },
        },
      }) as unknown as AssistantMessage,
  )
}

const text = (t: string): Block => ({ type: 'text', text: t })
let toolCounter = 0
const toolUse = (name: string, id = `toolu_q_${++toolCounter}`): Block => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

/** A step that streams one response made of `blocks`. */
function reply(...blocks: Block[]): Step {
  return async function* () {
    yield* assistant(blocks)
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ProbeTool = Tool & { calls: number }

/** A tool on the production execution path; `onCall` sees the live context. */
function probeTool(
  name: string,
  opts: { result?: string; onCall?: (ctx: ToolUseContext) => void; newMessages?: () => Message[] } = {},
): ProbeTool {
  const tool = buildTool({
    name,
    inputSchema: z.object({}).passthrough(),
    maxResultSizeChars: 1_000_000,
    async description() {
      return `${name} (probe)`
    },
    async prompt() {
      return `${name} (probe)`
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    mapToolResultToToolResultBlockParam(data: unknown, toolUseId: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseId, content: data as never }
    },
    renderToolUseMessage: () => null,
    async call(_input: unknown, ctx: ToolUseContext) {
      tool.calls++
      opts.onCall?.(ctx)
      return {
        data: opts.result ?? `${name} output`,
        ...(opts.newMessages ? { newMessages: opts.newMessages() } : {}),
      }
    },
  } as never) as unknown as ProbeTool
  tool.calls = 0
  return tool
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

type Event = { type: string; [k: string]: unknown }

type Run = {
  events: Event[]
  terminal: { reason: string; [k: string]: unknown }
  requests: CallArgs[]
  context: ToolUseContext
  appState: () => AppState
}

function makeContext(tools: Tools): { context: ToolUseContext; appState: () => AppState } {
  // A known session model, so the turn does not resolve one from the
  // developer's settings.
  let appState: AppState = { ...getDefaultAppState(), mainLoopModel: MODEL } as AppState
  const context = {
    options: {
      tools,
      commands: [],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'adaptive' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      debug: false,
      verbose: false,
      theme: 'dark',
    },
    getAppState: () => appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  } as unknown as ToolUseContext
  return { context, appState: () => appState }
}

async function drive(opts: {
  steps: Step[]
  tools?: Tool[]
  messages?: Message[]
  params?: Partial<QueryParams>
  autocompact?: QueryDeps['autocompact']
  setup?: (ctx: ToolUseContext) => void
  /** Requests past the script answer this; default a plain "done". */
  fallthrough?: Step
}): Promise<Run> {
  const tools = [...(opts.tools ?? [])] as Tools
  const { context, appState } = makeContext(tools)
  opts.setup?.(context)
  const requests: CallArgs[] = []
  const callModel = async function* (args: CallArgs) {
    requests.push(args)
    const step = opts.steps[requests.length - 1] ?? opts.fallthrough ?? reply(text('all done'))
    yield* step(args, context)
  }
  const deps: QueryDeps = {
    callModel: callModel as unknown as QueryDeps['callModel'],
    microcompact: (async (messages: Message[]) => ({ messages })) as never,
    autocompact: opts.autocompact ?? ((async () => ({ compactionResult: undefined })) as never),
    uuid: randomUUID,
  }
  const gen = query({
    messages: opts.messages ?? [createUserMessage({ content: 'do the thing' })],
    systemPrompt: asSystemPrompt(['You are a test agent.']),
    userContext: {},
    systemContext: {},
    canUseTool: (async (_tool: unknown, input: unknown) => ({
      behavior: 'allow',
      updatedInput: input,
    })) as never,
    toolUseContext: context,
    querySource: 'repl_main_thread',
    deps,
    ...opts.params,
  })
  const events: Event[] = []
  let r = await gen.next()
  // A runaway loop is a finding, not a hang.
  for (let i = 0; !r.done; i++) {
    if (i > 500) throw new Error('query() did not terminate')
    events.push(r.value as unknown as Event)
    r = await gen.next()
  }
  return {
    events,
    terminal: r.value as unknown as Run['terminal'],
    requests,
    context,
    appState,
  }
}

// -- event readers

function textOf(event: Event): string {
  const message = event.message as { content: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      const block = b as { type: string; text?: string; content?: unknown }
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'tool_result') {
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      }
      return ''
    })
    .join('')
}

function toolResultsIn(events: Event[]): Array<{ tool_use_id: string; content: unknown; is_error?: boolean; sourceToolAssistantUUID?: unknown }> {
  const out: Array<{ tool_use_id: string; content: unknown; is_error?: boolean; sourceToolAssistantUUID?: unknown }> = []
  for (const e of events) {
    if (e.type !== 'user') continue
    const content = (e.message as { content: unknown }).content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const block = b as { type: string; tool_use_id: string; content: unknown; is_error?: boolean }
      if (block.type === 'tool_result') out.push({ ...block, sourceToolAssistantUUID: e.sourceToolAssistantUUID })
    }
  }
  return out
}

const ofType = (events: Event[], type: string) => events.filter(e => e.type === type)
const attachmentsOf = (events: Event[], type: string) =>
  ofType(events, 'attachment').filter(e => (e.attachment as { type: string }).type === type)
const systemTexts = (events: Event[]) =>
  ofType(events, 'system').map(e => String(e.content))
const apiErrors = (events: Event[]) =>
  ofType(events, 'assistant').filter(e => e.isApiErrorMessage === true)
const userTexts = (events: Event[]) => ofType(events, 'user').map(textOf)

/** The text of every user message a request carried. */
function requestUserTexts(args: CallArgs): string[] {
  return (args.messages as Message[])
    .filter(m => m.type === 'user')
    .map(m => textOf(m as unknown as Event))
}

function addStopHook(ctx: ToolUseContext, callback: (messages: Message[]) => boolean, errorMessage = 'stop hook says keep going') {
  addFunctionHook(ctx.setAppState, getSessionId(), 'Stop', '', callback, errorMessage)
}

// ---------------------------------------------------------------------------
// Completion and tool follow-up
// ---------------------------------------------------------------------------

describe('query loop: completion and tool follow-up', () => {
  test('a reply without tool calls completes after one request', async () => {
    const run = await drive({ steps: [reply(text('All finished.'))] })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(1)
    expect(ofType(run.events, 'stream_request_start')).toHaveLength(1)
    expect(run.requests[0]!.options.model).toBe(MODEL)
  })

  test('a tool_use runs the tool and sends its result in a second request', async () => {
    const probe = probeTool('Probe', { result: 'probe output' })
    const id = 'toolu_follow_1'
    const run = await drive({
      steps: [reply(text('Running it.'), toolUse('Probe', id)), reply(text('Finished.'))],
      tools: [probe],
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(probe.calls).toBe(1)
    expect(run.requests).toHaveLength(2)
    const results = toolResultsIn(run.events)
    expect(results.map(r => r.tool_use_id)).toEqual([id])
    // The follow-up request carries the assistant tool_use and its result.
    const second = run.requests[1]!.messages as Message[]
    expect(requestUserTexts(run.requests[1]!).join('\n')).toContain('probe output')
    expect(second.some(m => m.type === 'assistant')).toBe(true)
  })

  test('getToolPermissionContext reads the live app state', async () => {
    let seen: unknown
    const run = await drive({
      steps: [
        async function* (args) {
          seen = await args.options.getToolPermissionContext()
          yield* assistant([text('ok, all done')])
        },
      ],
    })
    expect(seen).toBe(run.appState().toolPermissionContext)
  })

  test('maxTurns stops before the follow-up request and reports the next turn count', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [reply(toolUse('Probe'))],
      tools: [probe],
      params: { maxTurns: 1 },
    })
    expect(run.terminal).toEqual({ reason: 'max_turns', turnCount: 2 })
    expect(probe.calls).toBe(1)
    expect(run.requests).toHaveLength(1)
    const reached = attachmentsOf(run.events, 'max_turns_reached')
    expect(reached.map(e => e.attachment)).toEqual([
      { type: 'max_turns_reached', maxTurns: 1, turnCount: 2 },
    ])
  })

  test('maxTurns 2 allows exactly one follow-up', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [reply(toolUse('Probe')), reply(toolUse('Probe'))],
      tools: [probe],
      params: { maxTurns: 2 },
    })
    expect(run.terminal).toEqual({ reason: 'max_turns', turnCount: 3 })
    expect(run.requests).toHaveLength(2)
    expect(probe.calls).toBe(2)
  })

  test('a tool whose messages carry hook_stopped_continuation ends the turn', async () => {
    const probe = probeTool('Probe', {
      newMessages: () => [
        {
          type: 'attachment',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          attachment: {
            type: 'hook_stopped_continuation',
            message: 'stopped by hook',
            hookName: 'PostToolUse',
            toolUseID: 'x',
            hookEvent: 'PostToolUse',
          },
        } as unknown as Message,
      ],
    })
    const run = await drive({ steps: [reply(toolUse('Probe'))], tools: [probe] })
    expect(run.terminal).toEqual({ reason: 'hook_stopped' })
    expect(run.requests).toHaveLength(1)
  })

  test('refreshTools: the follow-up request sees the refreshed tool list', async () => {
    const probe = probeTool('Probe')
    const late = probeTool('LateMcpTool')
    const run = await drive({
      steps: [reply(toolUse('Probe')), reply(text('Finished.'))],
      tools: [probe],
      setup: ctx => {
        ;(ctx.options as { refreshTools?: () => Tools }).refreshTools = () =>
          [probe, late] as unknown as Tools
      },
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect((run.requests[0]!.tools as Tool[]).map(t => t.name)).toEqual(['Probe'])
    expect((run.requests[1]!.tools as Tool[]).map(t => t.name)).toEqual(['Probe', 'LateMcpTool'])
  })

  test('refreshTools returning the same array keeps the tools', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [reply(toolUse('Probe')), reply(text('Finished.'))],
      tools: [probe],
      setup: ctx => {
        ;(ctx.options as { refreshTools?: () => Tools }).refreshTools = () => ctx.options.tools
      },
    })
    expect((run.requests[1]!.tools as Tool[]).map(t => t.name)).toEqual(['Probe'])
  })
})

// ---------------------------------------------------------------------------
// Queued commands drained mid-turn
// ---------------------------------------------------------------------------

describe('query loop: queued commands', () => {
  test('a queued prompt is drained as an attachment, removed, and reported started then completed', async () => {
    const lifecycle: Array<[string, string]> = []
    setCommandLifecycleListener((uuid, state) => lifecycle.push([uuid, state]))
    const promptUuid = randomUUID()
    enqueue({ value: 'also update the README', mode: 'prompt', uuid: promptUuid as never })
    enqueue({ value: '/compact', mode: 'prompt', uuid: randomUUID() as never })
    enqueue({ value: 'for an agent', mode: 'prompt', agentId: 'agent-x' as never })
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [reply(toolUse('Probe')), reply(text('Finished.'))],
      tools: [probe],
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    const queued = attachmentsOf(run.events, 'queued_command')
    expect(queued.map(e => (e.attachment as { prompt: unknown }).prompt)).toEqual([
      'also update the README',
    ])
    // The slash command and the agent-addressed prompt stay queued.
    expect(getCommandQueue().map(c => c.value)).toEqual(['/compact', 'for an agent'])
    expect(lifecycle).toEqual([
      [promptUuid, 'started'],
      [promptUuid, 'completed'],
    ])
    // The follow-up request carries the drained prompt.
    const sent = (run.requests[1]!.messages as Message[]).filter(
      m => m.type === 'attachment' && m.attachment.type === 'queued_command',
    )
    expect(sent).toHaveLength(1)
  })

  test('a sub-agent drains only task notifications addressed to it', async () => {
    enqueue({ value: 'user prompt', mode: 'prompt', agentId: 'agent-1' as never })
    enqueue({ value: 'task done', mode: 'task-notification', agentId: 'agent-1' as never, priority: 'next' })
    enqueue({ value: 'other agent', mode: 'task-notification', agentId: 'agent-2' as never, priority: 'next' })
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [reply(toolUse('Probe')), reply(text('Finished.'))],
      tools: [probe],
      params: { querySource: 'agent:custom' as never },
      setup: ctx => {
        ;(ctx as { agentId?: string }).agentId = 'agent-1'
      },
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(getCommandQueue().map(c => c.value)).toEqual(['user prompt', 'other agent'])
  })

  test('a model error after draining still reports the consumed commands completed', async () => {
    const lifecycle: Array<[string, string]> = []
    setCommandLifecycleListener((uuid, state) => lifecycle.push([uuid, state]))
    const promptUuid = randomUUID()
    enqueue({ value: 'queued during tools', mode: 'prompt', uuid: promptUuid as never })
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [
        reply(toolUse('Probe')),
        async function* () {
          throw new Error('second request failed')
        },
      ],
      tools: [probe],
    })
    // A model error is a normal return, so the completion still fires.
    expect(run.terminal.reason).toBe('model_error')
    expect(lifecycle).toEqual([
      [promptUuid, 'started'],
      [promptUuid, 'completed'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Abort paths
// ---------------------------------------------------------------------------

describe('query loop: abort', () => {
  test('abort during streaming pairs each tool_use with an interrupted result', async () => {
    const probe = probeTool('Probe')
    const id = 'toolu_abort_stream'
    const run = await drive({
      steps: [
        async function* (_args, ctx) {
          yield* assistant([text('Starting.'), toolUse('Probe', id)])
          ctx.abortController.abort()
        },
      ],
      tools: [probe],
    })
    expect(run.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(probe.calls).toBe(0)
    const results = toolResultsIn(run.events)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ tool_use_id: id, content: 'Interrupted by user', is_error: true })
    expect(userTexts(run.events)).toContain(INTERRUPT_MESSAGE)
  })

  test('a submit-interrupt during streaming skips the interruption message', async () => {
    const run = await drive({
      steps: [
        async function* (_args, ctx) {
          yield* assistant([toolUse('Probe', 'toolu_abort_interrupt')])
          ctx.abortController.abort('interrupt')
        },
      ],
      tools: [probeTool('Probe')],
    })
    expect(run.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(toolResultsIn(run.events).map(r => r.content)).toEqual(['Interrupted by user'])
    expect(userTexts(run.events)).not.toContain(INTERRUPT_MESSAGE)
  })

  test('abort during tool execution returns aborted_tools with the tool-use interruption', async () => {
    const probe = probeTool('Probe', { onCall: ctx => ctx.abortController.abort() })
    const run = await drive({ steps: [reply(toolUse('Probe'))], tools: [probe] })
    expect(run.terminal).toEqual({ reason: 'aborted_tools' })
    expect(run.requests).toHaveLength(1)
    expect(userTexts(run.events)).toContain(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    expect(attachmentsOf(run.events, 'max_turns_reached')).toHaveLength(0)
  })

  test('abort during tools at the turn limit also reports max_turns_reached', async () => {
    const probe = probeTool('Probe', { onCall: ctx => ctx.abortController.abort() })
    const run = await drive({
      steps: [reply(toolUse('Probe'))],
      tools: [probe],
      params: { maxTurns: 1 },
    })
    expect(run.terminal).toEqual({ reason: 'aborted_tools' })
    expect(attachmentsOf(run.events, 'max_turns_reached').map(e => e.attachment)).toEqual([
      { type: 'max_turns_reached', maxTurns: 1, turnCount: 2 },
    ])
  })

  test('a submit-interrupt during tools skips the interruption message', async () => {
    const probe = probeTool('Probe', { onCall: ctx => ctx.abortController.abort('interrupt') })
    const run = await drive({ steps: [reply(toolUse('Probe'))], tools: [probe] })
    expect(run.terminal).toEqual({ reason: 'aborted_tools' })
    expect(userTexts(run.events)).not.toContain(INTERRUPT_MESSAGE_FOR_TOOL_USE)
  })
})

// ---------------------------------------------------------------------------
// Errors from the model call
// ---------------------------------------------------------------------------

describe('query loop: model errors', () => {
  test('a thrown error surfaces as an API error and closes open tool_uses', async () => {
    const id = 'toolu_err_1'
    const boom = new Error('socket hang up')
    const run = await drive({
      steps: [
        async function* () {
          yield* assistant([toolUse('Probe', id)])
          throw boom
        },
      ],
      tools: [probeTool('Probe')],
    })
    expect(run.terminal).toEqual({ reason: 'model_error', error: boom })
    expect(toolResultsIn(run.events)).toEqual([
      expect.objectContaining({ tool_use_id: id, content: 'socket hang up', is_error: true }),
    ])
    const errors = apiErrors(run.events)
    expect(errors.map(textOf)).toEqual(['socket hang up'])
  })

  test('a thrown non-Error is stringified', async () => {
    const run = await drive({
      steps: [
        async function* () {
          yield* []
          throw 'plain string failure'
        },
      ],
    })
    expect(run.terminal.reason).toBe('model_error')
    expect(apiErrors(run.events).map(textOf)).toEqual(['plain string failure'])
  })

  test('an image size error returns image_error without tool_result filler', async () => {
    const err = new ImageSizeError([{ index: 0, size: 10_000_000 }], 5_000_000)
    const run = await drive({
      steps: [
        async function* () {
          yield* assistant([toolUse('Probe', 'toolu_img')])
          throw err
        },
      ],
      tools: [probeTool('Probe')],
    })
    expect(run.terminal).toEqual({ reason: 'image_error' })
    expect(apiErrors(run.events).map(textOf)).toEqual([err.message])
    expect(toolResultsIn(run.events)).toEqual([])
  })

  test('an API error message from the model completes without running stop hooks', async () => {
    let hookCalls = 0
    const run = await drive({
      steps: [
        async function* () {
          yield createAssistantAPIErrorMessage({ content: 'Rate limited', error: 'rate_limit' as never })
        },
      ],
      setup: ctx =>
        addStopHook(ctx, () => {
          hookCalls++
          return false
        }),
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(hookCalls).toBe(0)
    expect(run.requests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// max_output_tokens recovery
// ---------------------------------------------------------------------------

describe('query loop: max_output_tokens recovery', () => {
  const truncated: Step = async function* () {
    yield* assistant([text('partial answer')], { extra: { error: 'max_output_tokens' } })
  }

  test('a truncated reply is withheld and the loop asks the model to resume', async () => {
    const run = await drive({ steps: [truncated, reply(text('All finished.'))] })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(2)
    // The withheld message is not yielded.
    expect(ofType(run.events, 'assistant').map(textOf)).toEqual(['All finished.'])
    const resume = requestUserTexts(run.requests[1]!).at(-1)
    expect(resume).toContain('Output token limit hit. Resume directly')
    // The truncated reply stays in the history the retry sends.
    expect((run.requests[1]!.messages as Message[]).some(m => m.type === 'assistant')).toBe(true)
  })

  test('after three recoveries the withheld error surfaces and the turn completes', async () => {
    const run = await drive({ steps: [], fallthrough: truncated })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(4)
    const yielded = ofType(run.events, 'assistant')
    expect(yielded).toHaveLength(1)
    expect(yielded[0]!.error).toBe('max_output_tokens')
  })
})

// ---------------------------------------------------------------------------
// Stop hooks
// ---------------------------------------------------------------------------

describe('query loop: stop hooks', () => {
  test('a blocking stop hook sends its message back and the loop retries once it passes', async () => {
    let hookCalls = 0
    const run = await drive({
      steps: [reply(text('All finished.')), reply(text('Really finished.'))],
      setup: ctx =>
        addStopHook(ctx, () => {
          hookCalls++
          return hookCalls > 1
        }, 'run the tests first'),
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(hookCalls).toBe(2)
    expect(run.requests).toHaveLength(2)
    expect(requestUserTexts(run.requests[1]!).join('\n')).toContain('run the tests first')
  })

  test('a stop hook answering continue:false prevents continuation', async () => {
    const run = await drive({
      steps: [reply(text('All finished.'))],
      setup: ctx =>
        addSessionHook(ctx.setAppState, getSessionId(), 'Stop', '', {
          type: 'command',
          command: `echo '{"continue": false, "stopReason": "hook says stop"}'`,
        } as never),
    })
    expect(run.terminal).toEqual({ reason: 'stop_hook_prevented' })
    expect(run.requests).toHaveLength(1)
    expect(
      attachmentsOf(run.events, 'hook_stopped_continuation').map(
        e => (e.attachment as { message: string }).message,
      ),
    ).toEqual(['hook says stop'])
  })
})

// ---------------------------------------------------------------------------
// Continuation nudge
// ---------------------------------------------------------------------------

describe('query loop: continuation nudge', () => {
  const NUDGE = 'Continue with the task. Use the appropriate tools to proceed.'

  test('a reply announcing more work without tool calls is nudged', async () => {
    const run = await drive({
      steps: [reply(text('Let me fix the remaining tests')), reply(text('All finished.'))],
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(2)
    expect(requestUserTexts(run.requests[1]!).at(-1)).toBe(NUDGE)
  })

  test('an unclosed code fence is nudged', async () => {
    const run = await drive({
      steps: [reply(text('Here is the file:\n```ts\nconst a = 1')), reply(text('All finished.'))],
    })
    expect(run.requests).toHaveLength(2)
    expect(requestUserTexts(run.requests[1]!).at(-1)).toBe(NUDGE)
  })

  test('the nudge is capped at three per turn', async () => {
    const run = await drive({ steps: [], fallthrough: reply(text('Let me fix the remaining tests')) })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(4)
  })

  test('no nudge at the turn limit', async () => {
    const run = await drive({
      steps: [reply(text('Let me fix the remaining tests'))],
      params: { maxTurns: 1 },
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Blocking limit and compaction
// ---------------------------------------------------------------------------

describe('query loop: blocking limit preflight', () => {
  test('at the blocking limit the loop answers PROMPT_TOO_LONG without calling the model', async () => {
    process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE = '1'
    const run = await drive({ steps: [reply(text('never sent'))] })
    expect(run.terminal).toEqual({ reason: 'blocking_limit' })
    expect(run.requests).toHaveLength(0)
    const errors = apiErrors(run.events)
    expect(errors.map(textOf)).toEqual([PROMPT_TOO_LONG_ERROR_MESSAGE])
    expect(errors[0]!.error).toBe('invalid_request')
  })

  test('a compact query is not blocked', async () => {
    process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE = '1'
    const run = await drive({ steps: [reply(text('summary'))], params: { querySource: 'compact' } })
    expect(run.requests).toHaveLength(1)
  })

  test('a turn that just compacted is not blocked', async () => {
    process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE = '1'
    const summary = createUserMessage({ content: 'summary of earlier work', isCompactSummary: true })
    const run = await drive({
      steps: [reply(text('All finished.'))],
      autocompact: (async () => ({
        compactionResult: {
          boundaryMarker: createCompactBoundaryMessage('auto', 1000),
          summaryMessages: [summary],
          attachments: [],
          hookResults: [],
        },
      })) as never,
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(1)
  })

  test('with compaction exhausted and the context over the threshold, the loop blocks', async () => {
    process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE = String(1e12)
    expect(isAutoCompactEnabled()).toBe(true)
    const big = assistant([text('earlier reply')], { usage: { input_tokens: 5_000_000 } })
    const run = await drive({
      steps: [reply(text('never sent'))],
      messages: [createUserMessage({ content: 'earlier' }), ...big, createUserMessage({ content: 'now' })],
      autocompact: (async () => ({ compactionResult: undefined, consecutiveFailures: 3 })) as never,
    })
    expect(run.terminal).toEqual({ reason: 'blocking_limit' })
    expect(run.requests).toHaveLength(0)
    expect(apiErrors(run.events).map(textOf)[0]).toContain(
      'automatic compaction has failed',
    )
  })

  test('two compaction failures still reach the model', async () => {
    process.env.CLAUDIN_BLOCKING_LIMIT_OVERRIDE = String(1e12)
    const big = assistant([text('earlier reply')], { usage: { input_tokens: 5_000_000 } })
    const run = await drive({
      steps: [reply(text('All finished.'))],
      messages: [createUserMessage({ content: 'earlier' }), ...big, createUserMessage({ content: 'now' })],
      autocompact: (async () => ({ compactionResult: undefined, consecutiveFailures: 2 })) as never,
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests).toHaveLength(1)
  })
})

describe('query loop: compaction', () => {
  test('a compaction yields the post-compact messages and the request is built from them', async () => {
    const prompt = createUserMessage({ content: 'original prompt' })
    const summary = createUserMessage({ content: 'summary of earlier work', isCompactSummary: true })
    const boundary = createCompactBoundaryMessage('auto', 1000)
    let compacts = 0
    const run = await drive({
      steps: [reply(text('All finished.'))],
      messages: [prompt],
      autocompact: (async () => {
        compacts++
        return compacts === 1
          ? {
              compactionResult: {
                boundaryMarker: boundary,
                summaryMessages: [summary],
                attachments: [],
                hookResults: [],
              },
            }
          : { compactionResult: undefined }
      }) as never,
    })
    expect(run.events.filter(e => e === (boundary as unknown) || e === (summary as unknown))).toHaveLength(2)
    const sent = requestUserTexts(run.requests[0]!).join('\n')
    expect(sent).toContain('summary of earlier work')
    expect(sent).not.toContain('original prompt')
  })

  test('task_budget: remaining is sent only after a compaction, minus the pre-compact window', async () => {
    const prior = assistant([text('earlier reply')], { usage: { input_tokens: 300, output_tokens: 50 } })
    const messages = [createUserMessage({ content: 'earlier' }), ...prior, createUserMessage({ content: 'now' })]
    const compactOnce = () => {
      let n = 0
      return (async () =>
        ++n === 1
          ? {
              compactionResult: {
                boundaryMarker: createCompactBoundaryMessage('auto', 1000),
                summaryMessages: [createUserMessage({ content: 'summary', isCompactSummary: true })],
                attachments: [],
                hookResults: [],
              },
            }
          : { compactionResult: undefined }) as never
    }
    const compacted = await drive({
      steps: [reply(text('All finished.'))],
      messages,
      params: { taskBudget: { total: 1000 } },
      autocompact: compactOnce(),
    })
    expect(compacted.requests[0]!.options.taskBudget).toEqual({ total: 1000, remaining: 650 })

    const plain = await drive({
      steps: [reply(text('All finished.'))],
      messages,
      params: { taskBudget: { total: 1000 } },
    })
    expect(plain.requests[0]!.options.taskBudget).toEqual({ total: 1000 })
  })
})

// ---------------------------------------------------------------------------
// Streaming fallback (the transport retried mid-stream)
// ---------------------------------------------------------------------------

describe('query loop: streaming fallback', () => {
  test('messages streamed before the fallback signal are tombstoned and their tools never run', async () => {
    const probe = probeTool('Probe')
    let first: AssistantMessage[] = []
    const run = await drive({
      steps: [
        async function* (args) {
          first = assistant([text('partial'), toolUse('Probe')])
          yield* first
          args.options.onStreamingFallback?.()
          // Two messages after the signal: the second must not tombstone the first.
          yield* assistant([text('Retrying.'), text('All finished.')])
        },
      ],
      tools: [probe],
    })
    expect(ofType(run.events, 'assistant').slice(-2).map(textOf)).toEqual(['Retrying.', 'All finished.'])
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(probe.calls).toBe(0)
    expect(run.requests).toHaveLength(1)
    const tombstones = ofType(run.events, 'tombstone').map(e => e.message)
    expect(tombstones).toEqual(first)
  })

  test('the signal re-arms: only what came before each signal is tombstoned', async () => {
    let a: AssistantMessage[] = []
    let b: AssistantMessage[] = []
    let c: AssistantMessage[] = []
    const run = await drive({
      steps: [
        async function* (args) {
          a = assistant([text('attempt one')])
          yield* a
          args.options.onStreamingFallback?.()
          b = assistant([text('attempt two')])
          yield* b
          c = assistant([text('attempt two, more')])
          yield* c
          args.options.onStreamingFallback?.()
          yield* assistant([text('All finished.')])
        },
      ],
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    const tombstones = ofType(run.events, 'tombstone').map(e => e.message)
    expect(tombstones).toEqual([...a, ...b, ...c])
  })
})

// ---------------------------------------------------------------------------
// FallbackTriggeredError: switch model and retry the request
// ---------------------------------------------------------------------------

describe('query loop: FallbackTriggeredError', () => {
  // The hold is process-wide: every test starts with none.
  beforeEach(() => _resetFallbackHoldsForTesting())
  afterAll(() => _resetFallbackHoldsForTesting())

  function overloadedOnce(
    originalModel = MODEL,
    fallbackModel = FALLBACK,
    toolId = 'toolu_fb_1',
    reason: FallbackReason = 'overloaded',
  ): Step {
    return async function* () {
      yield* assistant([text('thinking about it'), toolUse('Probe', toolId)])
      throw new FallbackTriggeredError(originalModel, fallbackModel, reason)
    }
  }

  const warning = (primary: string, why: string) =>
    `Switched to ${renderModelName(FALLBACK)}: ${renderModelName(primary)} ${why}. Staying on it for 10 minutes (/model to switch back).`

  test('the request is retried on the fallback model with a warning', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [overloadedOnce(), reply(text('All finished.'))],
      tools: [probe],
      params: { fallbackModel: FALLBACK },
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(run.requests.map(r => r.options.model)).toEqual([MODEL, FALLBACK])
    // The retry is the same request: one stream_request_start, same history.
    expect(ofType(run.events, 'stream_request_start')).toHaveLength(1)
    expect(run.requests[1]!.messages).toEqual(run.requests[0]!.messages)
    expect(run.requests[0]!.options.fallbackModel).toBe(FALLBACK)
    // One hop: the retry on the fallback carries none.
    expect(run.requests[1]!.options.fallbackModel).toBeUndefined()
    // The first attempt's tool never runs.
    expect(probe.calls).toBe(0)
    const warnings = ofType(run.events, 'system')
    expect(warnings.map(e => e.content)).toEqual([warning(MODEL, 'is overloaded')])
    expect(warnings[0]!.level).toBe('warning')
  })

  test.each([
    ['server_error', 'kept failing with server errors'],
    ['unreachable', 'could not be reached'],
    ['rate_limited', 'hit a rate limit'],
  ] as const)('a %s fallback says why', async (reason, why) => {
    const run = await drive({
      steps: [overloadedOnce(MODEL, FALLBACK, 'toolu_fb_why', reason), reply(text('All finished.'))],
      tools: [probeTool('Probe')],
      params: { fallbackModel: FALLBACK },
    })
    expect(systemTexts(run.events)).toEqual([warning(MODEL, why)])
  })

  test('the first attempt\'s tool_uses get "Model fallback triggered" results', async () => {
    const run = await drive({
      steps: [overloadedOnce(MODEL, FALLBACK, 'toolu_fb_tomb'), reply(text('All finished.'))],
      tools: [probeTool('Probe')],
      params: { fallbackModel: FALLBACK },
    })
    const firstAttempt = ofType(run.events, 'assistant').filter(e =>
      ((e.message as { content: Block[] }).content).some(b => b.type === 'tool_use'),
    )
    expect(firstAttempt).toHaveLength(1)
    const results = toolResultsIn(run.events)
    expect(results).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_fb_tomb',
        content: 'Model fallback triggered',
        is_error: true,
        sourceToolAssistantUUID: firstAttempt[0]!.uuid,
      } as never,
    ])
    // Order: the filler result, then the warning, then the retry's reply.
    const order = run.events
      .filter(e => e.type === 'user' || e.type === 'system' || e.type === 'assistant')
      .map(e => (e.type === 'assistant' ? textOf(e) || 'tool_use' : e.type))
    expect(order).toEqual(['thinking about it', 'tool_use', 'user', 'system', 'All finished.'])
    // Not tombstoned: the first attempt's messages stay (current behavior).
    expect(ofType(run.events, 'tombstone')).toHaveLength(0)
  })

  test('the switch writes the fallback into toolUseContext.options.mainLoopModel', async () => {
    const run = await drive({
      steps: [overloadedOnce(), reply(text('All finished.'))],
      tools: [probeTool('Probe')],
      params: { fallbackModel: FALLBACK },
    })
    expect(run.context.options.mainLoopModel).toBe(FALLBACK)
  })

  test('the follow-up request after a tool stays on the fallback model, held', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [
        async function* () {
          yield* []
          throw new FallbackTriggeredError(MODEL, FALLBACK, 'overloaded')
        },
        reply(toolUse('Probe')),
        reply(text('All finished.')),
      ],
      tools: [probe],
      params: { fallbackModel: FALLBACK },
    })
    expect(run.terminal).toEqual({ reason: 'completed' })
    // The session model in app state is unchanged; the hold is what keeps the
    // next iteration off the primary.
    expect(run.requests.map(r => r.options.model)).toEqual([MODEL, FALLBACK, FALLBACK])
    expect(run.requests[2]!.options.fallbackModel).toBeUndefined()
    expect(probe.calls).toBe(1)
    expect(systemTexts(run.events)).toHaveLength(1)
  })

  test('the next query starts on a held fallback, and on the primary once the hold is over', async () => {
    holdFallback(MODEL, FALLBACK)
    const held = await drive({ steps: [reply(text('On the fallback.'))], params: { fallbackModel: FALLBACK } })
    expect(held.requests.map(r => r.options.model)).toEqual([FALLBACK])
    expect(systemTexts(held.events)).toEqual([])

    holdFallback(MODEL, FALLBACK, Date.now() - FALLBACK_HOLD_MS - 1)
    const released = await drive({ steps: [reply(text('Back.'))], params: { fallbackModel: FALLBACK } })
    expect(released.requests.map(r => r.options.model)).toEqual([MODEL])
    expect(released.requests[0]!.options.fallbackModel).toBe(FALLBACK)
  })

  test('a hold means nothing to a query with no fallback configured', async () => {
    holdFallback(MODEL, FALLBACK)
    const run = await drive({ steps: [reply(text('Primary.'))] })
    expect(run.requests.map(r => r.options.model)).toEqual([MODEL])
  })

  test('the warning names the configured fallback and the model that gave way', async () => {
    const run = await drive({
      steps: [overloadedOnce('claude-opus-4-1', 'claude-haiku-4-5'), reply(text('All finished.'))],
      tools: [probeTool('Probe')],
      params: { fallbackModel: FALLBACK },
    })
    expect(systemTexts(run.events)).toEqual([warning('claude-opus-4-1', 'is overloaded')])
    // The retry uses the configured fallback, whatever the error says.
    expect(run.requests[1]!.options.model).toBe(FALLBACK)
  })

  test('one hop: a FallbackTriggeredError on the fallback ends the turn instead of retrying it', async () => {
    const run = await drive({
      steps: [
        overloadedOnce(MODEL, FALLBACK, 'toolu_fb_a'),
        overloadedOnce(FALLBACK, FALLBACK, 'toolu_fb_b'),
        reply(text('All finished.')),
      ],
      tools: [probeTool('Probe')],
      params: { fallbackModel: FALLBACK },
    })
    expect(run.terminal.reason).toBe('model_error')
    expect(run.requests.map(r => r.options.model)).toEqual([MODEL, FALLBACK])
    expect(systemTexts(run.events)).toHaveLength(1)
  })

  test('without a fallbackModel the error ends the turn as a model error', async () => {
    const probe = probeTool('Probe')
    const run = await drive({
      steps: [overloadedOnce(MODEL, FALLBACK, 'toolu_fb_none')],
      tools: [probe],
    })
    expect(run.terminal.reason).toBe('model_error')
    expect(run.terminal.error).toBeInstanceOf(FallbackTriggeredError)
    expect(run.requests).toHaveLength(1)
    expect(systemTexts(run.events)).toEqual([])
    expect(run.context.options.mainLoopModel).toBe(MODEL)
    const message = `Model fallback triggered: ${MODEL} -> ${FALLBACK}`
    expect(apiErrors(run.events).map(textOf)).toEqual([message])
    expect(toolResultsIn(run.events).map(r => r.content)).toEqual([message])
  })
})
