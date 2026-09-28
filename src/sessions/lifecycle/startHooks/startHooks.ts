/**
 * What runs when a session starts: the SessionStart hooks (startup, resume,
 * /clear, compaction) and the Setup hooks (init, maintenance). Their output
 * becomes messages for the conversation, one attachment with every additional
 * context, an initial user message, and paths for the file watcher.
 */
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { getMainThreadAgentType } from 'src/platform/bootstrap/state.js'
import { updateWatchPaths } from 'src/platform/lifecycleHooks/fileChangedWatcher.js'
import {
  type AggregatedHookResult,
  executeSessionStartHooks,
  executeSetupHooks,
} from 'src/platform/lifecycleHooks/hooks.js'
import { holdInitialUserMessage } from 'src/sessions/lifecycle/startHooks/initialUserMessage.js'
import {
  loadPluginHooksBeforeStart,
  type StartEvent,
} from 'src/sessions/lifecycle/startHooks/pluginHooks.js'
import { isBareMode } from 'src/shared/envUtils.js'
import type { HookResultMessage } from 'src/shared/types/message.js'

type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
type SetupTrigger = 'init' | 'maintenance'

type StartOptions = {
  /** Wait for `async` hooks as well, so that their output counts. */
  forceSyncExecution?: boolean
}

type SessionStartOptions = StartOptions & {
  sessionId?: string
  agentType?: string
  model?: string
}

/** The matcher query is the source for SessionStart and the trigger for Setup. */
type StartRequest =
  | { event: 'SessionStart'; query: SessionStartSource; options: SessionStartOptions }
  | { event: 'Setup'; query: SetupTrigger; options: StartOptions }

type StartOutput = {
  messages: HookResultMessage[]
  contexts: string[]
  watchPaths: string[]
  initialUserMessage: string | undefined
}

export function processSessionStartHooks(
  source: SessionStartSource,
  options: SessionStartOptions = {},
): Promise<HookResultMessage[]> {
  return runStartHooks({ event: 'SessionStart', query: source, options })
}

export function processSetupHooks(
  trigger: SetupTrigger,
  options: StartOptions = {},
): Promise<HookResultMessage[]> {
  return runStartHooks({ event: 'Setup', query: trigger, options })
}

async function runStartHooks(request: StartRequest): Promise<HookResultMessage[]> {
  if (isBareMode()) return []
  await loadPluginHooksBeforeStart(request.event, request.query)
  const output = await collectOutput(executeStartHooks(request))
  if (output.initialUserMessage !== undefined) holdInitialUserMessage(output.initialUserMessage)
  // A start that names no paths leaves alone those an earlier start asked for.
  if (output.watchPaths.length > 0) updateWatchPaths(output.watchPaths)
  if (output.contexts.length === 0) return output.messages
  return [...output.messages, additionalContextMessage(request.event, output.contexts)]
}

function executeStartHooks(request: StartRequest): AsyncGenerator<AggregatedHookResult> {
  if (request.event === 'Setup') {
    return executeSetupHooks(request.query, undefined, undefined, request.options.forceSyncExecution)
  }
  const { sessionId, agentType, model, forceSyncExecution } = request.options
  // Without a session id the hook engine uses the current session's.
  return executeSessionStartHooks(
    request.query,
    sessionId,
    agentType ?? getMainThreadAgentType(),
    model,
    undefined,
    undefined,
    forceSyncExecution,
  )
}

async function collectOutput(results: AsyncIterable<AggregatedHookResult>): Promise<StartOutput> {
  const output: StartOutput = {
    messages: [],
    contexts: [],
    watchPaths: [],
    initialUserMessage: undefined,
  }
  for await (const result of results) {
    if (result.message) output.messages.push(result.message)
    output.contexts.push(...(result.additionalContexts ?? []))
    output.watchPaths.push(...(result.watchPaths ?? []))
    // The hooks run in parallel: the one that finishes last wins.
    if (result.initialUserMessage) output.initialUserMessage = result.initialUserMessage
  }
  return output
}

/** Every context of the run in one attachment, named after the event on each field. */
function additionalContextMessage(event: StartEvent, contexts: string[]): HookResultMessage {
  return createAttachmentMessage({
    type: 'hook_additional_context',
    content: contexts,
    hookName: event,
    toolUseID: event,
    hookEvent: event,
  })
}
