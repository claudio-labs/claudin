/**
 * Drives the real query loop (src/agent/query.ts) with a scripted model, and
 * carries its output into the next turn the way each consumer does — the
 * REPL's message array, the transcript a --resume rebuilds from, and the raw
 * accumulation headless keeps. Every request the loop makes is recorded, so
 * the prefix invariant (cache.md §1) can be checked across all of them with
 * prefixInvariant.ts.
 *
 * Only the model is fake. The loop, tool execution, the attachment pipeline,
 * the REPL reducer (src/agent/repl/queryMessages.ts) and the transcript round
 * trip are the production code.
 */
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { query } from 'src/agent/query.js'
import type { QueryDeps } from 'src/agent/query/deps.js'
import { appendQueryMessage, settleTurnMessages } from 'src/agent/repl/queryMessages.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import { deserializeMessages } from 'src/sessions/conversationRecovery.js'
import { cleanMessagesForLogging } from 'src/sessions/sessionStorage.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { buildTool, type Tool, type ToolUseContext, type Tools } from 'src/tools/Tool.js'
import { wireMessages } from 'src/agent/cache/__testutils__/prefixInvariant.js'

export const MODEL = 'claude-opus-5-5'

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

export type ToolCall = { name: string; input: Record<string, unknown> }

/** One model response. Thinking is on by default: it is what binds to the prefix. */
export type ModelStep = { thinking?: boolean; text?: string; tools?: ToolCall[] }

export type CapturedRequest = {
  index: number
  turn: number
  messages: Message[]
  /** The request's wire bytes, rendered when it was sent: stub state moves. */
  wire: string[]
}

export type ScriptedModel = {
  callModel: QueryDeps['callModel']
  requests: CapturedRequest[]
  /** Steps not consumed yet — a scenario that left some did not run. */
  remaining: () => number
  /** Set by the harness before each turn, recorded on every request. */
  setTurn: (turn: number) => void
}

/**
 * A model that answers each request with the next step. It streams the way
 * queryModelWithStreaming does: one AssistantMessage per content block, all
 * sharing the response's message id.
 */
export function scriptedModel(
  steps: readonly ModelStep[],
  tools: Tools,
): ScriptedModel {
  const requests: CapturedRequest[] = []
  let next = 0
  let turn = 0
  const callModel = async function* (
    args: Parameters<QueryDeps['callModel']>[0],
  ): AsyncGenerator<AssistantMessage> {
    requests.push({
      index: requests.length,
      turn,
      messages: [...args.messages],
      wire: wireMessages(args.messages, tools),
    })
    const step = steps[next] ?? { text: 'done' }
    next++
    const id = `msg_loop_${requests.length}`
    const blocks: AssistantMessage['message']['content'] = []
    if (step.thinking !== false) {
      blocks.push({
        type: 'thinking',
        thinking: `thinking for request ${requests.length}`,
        signature: `sig_${requests.length}`,
      } as never)
    }
    if (step.text !== undefined) blocks.push({ type: 'text', text: step.text } as never)
    for (const [i, call] of (step.tools ?? []).entries()) {
      blocks.push({
        type: 'tool_use',
        id: `toolu_loop_${requests.length}_${i}`,
        name: call.name,
        input: call.input,
      } as never)
    }
    if (step.text === undefined && !step.tools?.length) {
      blocks.push({ type: 'text', text: 'done' } as never)
    }
    const stopReason = step.tools?.length ? 'tool_use' : 'end_turn'
    for (const block of blocks) {
      yield {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        requestId: id,
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
          },
        },
      } as unknown as AssistantMessage
    }
  }
  return {
    callModel: callModel as unknown as QueryDeps['callModel'],
    requests,
    remaining: () => Math.max(0, steps.length - next),
    setTurn: t => {
      turn = t
    },
  }
}

// ---------------------------------------------------------------------------
// Stub tools
// ---------------------------------------------------------------------------

export type StubToolSpec = {
  name: string
  /** The tool_result content: a string, or blocks (an array result). */
  result: string | Array<{ type: 'text'; text: string }>
  /** Messages the call adds after its result (a Skill's body, a hook's context). */
  newMessages?: () => Message[]
  /** Progress ticks emitted while the call runs. */
  progress?: Array<{ type: string; [k: string]: unknown }>
  concurrencySafe?: boolean
  /** Wraps backfillObservableInput, to model a tool whose observable input grows. */
  backfillObservableInput?: (input: Record<string, unknown>) => void
}

/** A tool built with buildTool, so it takes the production execution path. */
export function stubTool(spec: StubToolSpec): Tool {
  return buildTool({
    name: spec.name,
    inputSchema: z.object({}).passthrough(),
    maxResultSizeChars: 1_000_000,
    async description() {
      return `${spec.name} (stub)`
    },
    async prompt() {
      return `${spec.name} (stub)`
    },
    isConcurrencySafe: () => spec.concurrencySafe ?? false,
    isReadOnly: () => true,
    ...(spec.backfillObservableInput
      ? { backfillObservableInput: spec.backfillObservableInput }
      : {}),
    mapToolResultToToolResultBlockParam(data: unknown, toolUseId: string) {
      return { type: 'tool_result' as const, tool_use_id: toolUseId, content: data as never }
    },
    renderToolUseMessage: () => null,
    async call(
      _input: unknown,
      _context: unknown,
      _canUseTool: unknown,
      _parent: unknown,
      onProgress?: (p: { toolUseID: string; data: unknown }) => void,
    ) {
      for (const [i, data] of (spec.progress ?? []).entries()) {
        onProgress?.({ toolUseID: `progress_${spec.name}_${i}`, data })
      }
      return {
        data: spec.result,
        ...(spec.newMessages ? { newMessages: spec.newMessages() } : {}),
      }
    },
  } as never) as unknown as Tool
}

// ---------------------------------------------------------------------------
// Consumers: how the next turn gets its history
// ---------------------------------------------------------------------------

/**
 * - `repl`: the interactive REPL — appendQueryMessage per yielded message,
 *   settleTurnMessages when the turn ends.
 * - `resume`: the REPL's array written as the transcript and read back, the
 *   way `--resume` starts the next process.
 * - `raw`: every message kept as yielded (headless keeps them unchanged).
 */
export type Consumer = 'repl' | 'resume' | 'raw'

const STORED_TYPES = new Set(['assistant', 'user', 'attachment', 'progress', 'system'])

function isStored(event: { type: string }): event is Message {
  return STORED_TYPES.has(event.type)
}

function roundTripTranscript(messages: Message[]): Message[] {
  return deserializeMessages(JSON.parse(JSON.stringify(cleanMessagesForLogging(messages))))
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export type SessionResult = {
  requests: CapturedRequest[]
  /** What the consumer holds after the last turn. */
  history: Message[]
  /** Steps of the script never reached — non-zero means the scenario did not run. */
  unusedSteps: number
  tools: Tools
}

function makeContext(tools: Tools): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      tools,
      commands: [],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'adaptive' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      debug: false,
      verbose: false,
      theme: 'dark',
    },
    getAppState: () => appState,
    setAppState: () => {},
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
}

/**
 * Runs one prompt per turn through query(), carrying the history to the next
 * turn through `consumer`. The script is shared by every turn: a turn ends at
 * the first step without tool calls.
 */
export async function runSession(opts: {
  prompts: readonly string[]
  script: readonly ModelStep[]
  tools: readonly Tool[]
  consumer: Consumer
}): Promise<SessionResult> {
  const tools = [...opts.tools] as Tools
  const model = scriptedModel(opts.script, tools)
  const context = makeContext(tools)
  const deps: QueryDeps = {
    callModel: model.callModel,
    // Microcompact and autocompact are the relief/compaction policies; their
    // own suites cover what they rewrite and announce. Identity here keeps the
    // check about the loop and the consumers.
    microcompact: (async (messages: Message[]) => ({ messages })) as never,
    autocompact: (async () => ({ compactionResult: undefined })) as never,
    uuid: randomUUID,
  }
  const profile = getCacheProfile()
  let history: Message[] = []
  for (const [turn, prompt] of opts.prompts.entries()) {
    model.setTurn(turn)
    history = [...history, createUserMessage({ content: prompt })]
    const turnStart = history
    // The REPL applies each message as it arrives (useOnQuery's onQueryEvent),
    // during the turn — the clip registry it consults is shared with the wire.
    let repl = history
    const yielded: Message[] = []
    for await (const event of query({
      messages: turnStart,
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
    })) {
      if (!isStored(event)) continue
      yielded.push(event)
      if (opts.consumer !== 'raw') repl = appendQueryMessage(repl, event, profile)
    }
    switch (opts.consumer) {
      case 'raw':
        history = [...turnStart, ...yielded]
        break
      case 'repl':
        history = settleTurnMessages(repl, profile)
        break
      case 'resume':
        history = roundTripTranscript(settleTurnMessages(repl, profile))
        break
    }
  }
  return { requests: model.requests, history, unusedSteps: model.remaining(), tools }
}
