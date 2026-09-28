/**
 * The background extraction as a state machine: one runner per
 * initExtractMemories, fed every end of a main-thread turn.
 *
 * It keeps a mark (the last message already accounted for), the cadence
 * count, the loops already acted on, whether a fork is running, the latest end
 * of turn that arrived meanwhile, and the calls a drain has to wait for. What
 * it reads from outside comes through `ExtractionDeps`.
 */
import type { ForkedAgentResult } from 'src/agent/coordinator/forkedAgent.js'
import {
  buildExtractionForkRequest,
  type ExtractionForkRequest,
} from 'src/memory/extract/fork/forkRequest.js'
import { createAutoMemCanUseTool, isInsideDirectory } from 'src/memory/extract/fork/permissions.js'
import { memorySavedNotice } from 'src/memory/extract/fork/savedNotice.js'
import {
  countExchangeMessages,
  mainAgentSavedMemory,
  messagesAfterMark,
  savedMemoryFiles,
} from 'src/memory/extract/fork/transcript.js'
import {
  decideExtraction,
  type ExtractionDecision,
  type ForkDecision,
  type ForkOverlap,
  type FiredLoops,
  NO_FIRED_LOOPS,
  withFiredLoop,
} from 'src/memory/extract/fork/triggerPolicy.js'
import { detectRepeatedErrorLoop } from 'src/memory/extract/loopDetector.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
  buildLoopHint,
} from 'src/memory/extract/prompts.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logError } from 'src/shared/log.js'
import type { Message, SystemLocalCommandMessage, SystemMessage } from 'src/shared/types/message.js'

export type AppendSystemMessage = (message: Exclude<SystemMessage, SystemLocalCommandMessage>) => void

/** The switches and settings the extraction consults, each read at the moment it needs it. */
export type ExtractionSettings = {
  readonly extractionEnabled: () => boolean
  readonly autoMemoryEnabled: () => boolean
  /** A routine fork on every Nth end of turn that counts. */
  readonly turnInterval: () => number
  readonly loopTriggerEnabled: () => boolean
  /** Team memory sits beside private memory, so the fork gets the combined prompt. */
  readonly teamMemoryEnabled: () => boolean
  /** The user asked to be told when memories are saved. */
  readonly announceSavedMemories: () => boolean
}

/** Where memories live, as the memory directory's own module defines it. */
type MemoryLocation = {
  readonly directory: () => string
  readonly contains: (filePath: string) => boolean
  readonly containsTeamFile: (filePath: string) => boolean
}

export type ExtractionDeps = {
  readonly runFork: (request: ExtractionForkRequest) => Promise<ForkedAgentResult>
  /** One line per memory file already in the directory, or '' when there is none. */
  readonly readManifest: (memoryDir: string) => Promise<string>
  readonly settings: ExtractionSettings
  readonly memory: MemoryLocation
}

export type ExtractionRunner = {
  /**
   * One end of a main-thread turn. Settles once the fork it started, if any,
   * and the forks that follow it for turns kept meanwhile, are done. Never
   * rejects.
   */
  readonly onTurnEnd: (context: REPLHookContext, appendSystemMessage?: AppendSystemMessage) => Promise<void>
  /** Waits for the ends of turn still in flight, or `timeoutMs`, whichever comes first. */
  readonly drain: (timeoutMs: number) => Promise<void>
}

type Turn = {
  readonly context: REPLHookContext
  readonly appendSystemMessage: AppendSystemMessage | undefined
}

type ForkJob = { readonly turn: Turn; readonly decision: ForkDecision }

type RunnerState = {
  /** uuid of the last message accounted for: seen by a fork, or passed over for the main agent's own save. */
  mark: string | undefined
  turnsCounted: number
  firedLoops: FiredLoops
  forkRunning: boolean
  /** The latest end of turn that arrived while a fork ran; the ones before it are dropped. */
  kept: Turn | undefined
  readonly inFlight: Set<Promise<void>>
}

const LOG_PREFIX = '[extractMemories]'

function lastMessageId(messages: readonly Message[]): string | undefined {
  return messages.at(-1)?.uuid
}

function logUsage(usage: ForkedAgentResult['totalUsage']): void {
  logForDebugging(
    `${LOG_PREFIX} fork finished: ${usage.input_tokens} input, ${usage.cache_read_input_tokens} cache-read, ${usage.cache_creation_input_tokens} cache-write, ${usage.output_tokens} output tokens`,
  )
}

export function createExtractionRunner(deps: ExtractionDeps): ExtractionRunner {
  const { settings, memory } = deps
  const state: RunnerState = {
    mark: undefined,
    turnsCounted: 0,
    firedLoops: NO_FIRED_LOOPS,
    forkRunning: false,
    kept: undefined,
    inFlight: new Set(),
  }

  function decide({ context }: Turn, overlap: ForkOverlap): ExtractionDecision {
    return decideExtraction({
      gates: {
        subAgentTurn: Boolean(context.toolUseContext.agentId),
        extractionEnabled: settings.extractionEnabled(),
        autoMemoryEnabled: settings.autoMemoryEnabled(),
      },
      overlap,
      turnsCounted: state.turnsCounted,
      interval: settings.turnInterval(),
      firedLoops: state.firedLoops,
      mainAgentSaved: () => mainAgentSavedMemory(context.messages, state.mark, memory.contains),
      repeatedErrorLoop: () =>
        settings.loopTriggerEnabled() ? detectRepeatedErrorLoop(context.messages) : null,
    })
  }

  function settleWithoutFork(turn: Turn, decision: Exclude<ExtractionDecision, ForkDecision>): void {
    switch (decision.kind) {
      case 'gated':
        return
      case 'held':
        state.kept = turn
        return
      case 'mainAgentSaved':
        state.mark = lastMessageId(turn.context.messages)
        logForDebugging(`${LOG_PREFIX} the main agent saved a memory itself; moving past its turn`)
        return
      case 'throttled':
        state.turnsCounted = decision.turnsCounted
        return
    }
  }

  /** Every fork restarts the cadence, a failed one included, and a loop is acted on once. */
  function beginFork(turn: Turn, decision: ForkDecision): ForkJob {
    state.turnsCounted = 0
    if (decision.reason === 'loop') state.firedLoops = withFiredLoop(state.firedLoops, decision.loop)
    return { turn, decision }
  }

  /** The fork for the end of turn kept while the last one ran, if it still gets one. */
  function followingFork(): ForkJob | undefined {
    const turn = state.kept
    state.kept = undefined
    if (turn === undefined) return undefined
    const decision = decide(turn, 'trailing')
    if (decision.kind === 'fork') return beginFork(turn, decision)
    settleWithoutFork(turn, decision)
    return undefined
  }

  function announceSaves(
    forkMessages: readonly Message[],
    memoryDir: string,
    appendSystemMessage: AppendSystemMessage | undefined,
  ): void {
    if (appendSystemMessage === undefined || !settings.announceSavedMemories()) return
    const saved = savedMemoryFiles(forkMessages, filePath => isInsideDirectory(filePath, memoryDir))
    if (saved.length > 0) appendSystemMessage(memorySavedNotice(saved, memory.containsTeamFile))
  }

  /** A failure is logged and absorbed. The mark stays, so the same messages are new next time. */
  async function runFork({ turn, decision }: ForkJob): Promise<void> {
    const { context, appendSystemMessage } = turn
    try {
      const newMessages = countExchangeMessages(messagesAfterMark(context.messages, state.mark))
      const hint = decision.reason === 'loop'
        ? buildLoopHint(decision.loop.toolName, decision.loop.repeatCount)
        : undefined
      const memoryDir = memory.directory()
      const manifest = await deps.readManifest(memoryDir)
      const prompt = settings.teamMemoryEnabled()
        ? buildExtractCombinedPrompt(newMessages, manifest, hint)
        : buildExtractAutoOnlyPrompt(newMessages, manifest, hint)
      logForDebugging(`${LOG_PREFIX} starting a ${decision.reason} fork over ~${newMessages} new messages`)
      const result = await deps.runFork(
        buildExtractionForkRequest(context, prompt, createAutoMemCanUseTool(memoryDir)),
      )
      state.mark = lastMessageId(context.messages)
      logUsage(result.totalUsage)
      announceSaves(result.messages, memoryDir, appendSystemMessage)
    } catch (error) {
      logError(error)
    }
  }

  async function handleTurnEnd(turn: Turn): Promise<void> {
    const decision = decide(turn, state.forkRunning ? 'forkRunning' : 'none')
    if (decision.kind !== 'fork') {
      settleWithoutFork(turn, decision)
      return
    }
    state.forkRunning = true
    try {
      let job: ForkJob | undefined = beginFork(turn, decision)
      while (job !== undefined) {
        await runFork(job)
        job = followingFork()
      }
    } finally {
      state.forkRunning = false
    }
  }

  return {
    onTurnEnd(context, appendSystemMessage) {
      const settled = handleTurnEnd({ context, appendSystemMessage }).catch(logError)
      state.inFlight.add(settled)
      void settled.then(() => state.inFlight.delete(settled))
      return settled
    },

    async drain(timeoutMs) {
      if (state.inFlight.size === 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        // The drain's own timer must never be what keeps an exiting process alive.
        timer.unref?.()
      })
      try {
        await Promise.race([Promise.allSettled([...state.inFlight]), timedOut])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
