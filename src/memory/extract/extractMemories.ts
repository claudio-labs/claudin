/**
 * Extracts durable memories from the current session transcript
 * and writes them to the auto-memory directory (~/.claudin/projects/<path>/memory/).
 *
 * It runs once at the end of each complete query loop (when the model produces
 * a final response with no tool calls) via handleStopHooks in stopHooks.ts.
 *
 * Uses the forked agent pattern (runForkedAgent) — a perfect fork of the main
 * conversation that shares the parent's prompt cache.
 * CLAUDIN_EXTRACT_MEMORIES_MODEL swaps the fork for a fresh agent on another
 * model (freshAgentParams).
 *
 * State is closure-scoped inside initExtractMemories() rather than module-level,
 * following the same pattern as confidenceRating.ts. Tests call
 * initExtractMemories() in beforeEach to get a fresh closure.
 */

import { feature } from 'bun:bundle'
import { basename } from 'path'
import { readFileSync } from 'fs'
import { getIsRemoteMode } from 'src/platform/bootstrap/state.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from 'src/memory/memdir/memoryScan.js'
import {
  getExtractionTurnInterval,
  isAutoMemoryEnabled,
  isExtractMemoriesEnabled,
} from 'src/memory/memdir/paths.js'
import {
  getMemoryDir,
  getMemoryDirs,
  type MemoryDir,
  memoryScopeOf,
} from 'src/memory/memdir/memoryDirs.js'
import {
  ENTRYPOINT_NAME,
  type MemoryScope,
  withoutTrailingSep,
} from 'src/memory/memdir/memoryScopes.js'
import type { Tool } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { writtenPaths as writtenPathsOf } from 'src/tools/shared/writtenPaths.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import type {
  AssistantMessage,
  Message,
  SystemLocalCommandMessage,
  SystemMessage,
} from 'src/shared/types/message.js'
import { createAbortController } from 'src/shared/abortController.js'
import { count, uniq } from 'src/shared/data/array.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
  type SubagentContextOverrides,
} from 'src/agent/coordinator/forkedAgent.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import {
  createMemorySavedMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { isHumanTurn } from 'src/agent/messages/messagePredicates.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import { type EffortValue, parseEffortValue } from 'src/providers/effort/effort.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { detectRepeatedErrorLoop } from 'src/memory/extract/loopDetector.js'
import {
  buildExtractCombinedPrompt,
  buildLoopHint,
} from 'src/memory/extract/prompts.js'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns true if a message is visible to the model (sent in API calls).
 * Excludes progress, system, and attachment messages.
 */
function isModelVisibleMessage(message: Message): boolean {
  return message.type === 'user' || message.type === 'assistant'
}

/**
 * Repeated-error loop trigger: default-ON via the build flag, opt-out with
 * CLAUDIN_LOOP_MEMORY_TRIGGER=0 (mirrors the JSON-compression env pattern).
 */
function isLoopTriggerEnabled(): boolean {
  // `feature()` (bun:bundle macro) must be used directly in an if/ternary — a
  // `&&` form throws when these modules are imported under `bun test`. The build
  // preprocessor folds it to a boolean literal either way.
  if (!feature('LOOP_ERROR_MEMORY_TRIGGER')) return false
  return !isEnvDefinedFalsy(process.env.CLAUDIN_LOOP_MEMORY_TRIGGER)
}

function countModelVisibleMessagesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): number {
  if (sinceUuid === null || sinceUuid === undefined) {
    return count(messages, isModelVisibleMessage)
  }

  let foundStart = false
  let n = 0
  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true
      }
      continue
    }
    if (isModelVisibleMessage(message)) {
      n++
    }
  }
  // If sinceUuid was not found (e.g., removed by context compaction),
  // fall back to counting all model-visible messages rather than returning 0
  // which would permanently disable extraction for the rest of the session.
  if (!foundStart) {
    return count(messages, isModelVisibleMessage)
  }
  return n
}

/**
 * Returns true if any assistant message after the cursor UUID contains a
 * tool_use block that writes a memory path — a Write, an Edit or a Patch,
 * by input shape (writtenPaths.ts).
 *
 * The main agent's prompt has full save instructions — when it writes
 * memories, the forked extraction is redundant. runExtraction skips the
 * agent and advances the cursor past this range, making the main agent
 * and the background agent mutually exclusive per turn.
 */
export function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): boolean {
  let foundStart = sinceUuid === undefined
  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true
      }
      continue
    }
    if (message.type !== 'assistant') {
      continue
    }
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (blockWrittenPaths(block).some(path => memoryScopeOf(path) !== null)) {
        return true
      }
    }
  }
  return false
}

// ============================================================================
// Tool Permissions
// ============================================================================

function denyMemoryTool(tool: Tool, reason: string) {
  logForDebugging(`[autoMem] denied ${tool.name}: ${reason}`)
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: { type: 'other' as const, reason },
  }
}

/**
 * Whether an Edit or Write only adds to `filePath`: an Edit whose new text
 * keeps the old, a Write of a new file or of content that keeps the file's.
 */
function onlyAdds(toolName: string, input: Record<string, unknown>, filePath: string): boolean {
  if (toolName === FILE_EDIT_TOOL_NAME) {
    return (
      typeof input.old_string === 'string' &&
      typeof input.new_string === 'string' &&
      input.new_string.includes(input.old_string)
    )
  }
  let existing: string
  try {
    existing = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return isENOENT(e)
  }
  return typeof input.content === 'string' && input.content.includes(existing.trimEnd())
}

/**
 * Creates a canUseTool function that allows Read/Grep/Glob (unrestricted),
 * read-only Bash commands, and Edit/Write only within the memory directories
 * (memoryDirs.ts). Shared by extractMemories and autoDream.
 *
 * `appendOnly` scopes take an Edit or Write only when it adds: both forks
 * pass the global dir, which they may add to but never prune — one project's
 * run cannot tell that a memory every project reads is stale.
 */
export function createMemoryCanUseTool(
  appendOnly: readonly MemoryScope[] = [],
): CanUseToolFn {
  return async (tool: Tool, input: Record<string, unknown>) => {
    // Allow Read/Grep/Glob unrestricted — all inherently read-only
    if (
      tool.name === FILE_READ_TOOL_NAME ||
      tool.name === GREP_TOOL_NAME ||
      tool.name === GLOB_TOOL_NAME
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // Allow Bash only for commands that pass BashTool.isReadOnly.
    // `tool` IS BashTool here — no static import needed.
    if (tool.name === BASH_TOOL_NAME) {
      const parsed = tool.inputSchema.safeParse(input)
      if (parsed.success && tool.isReadOnly(parsed.data)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return denyMemoryTool(
        tool,
        'Only read-only shell commands are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)',
      )
    }

    if (
      (tool.name === FILE_EDIT_TOOL_NAME ||
        tool.name === FILE_WRITE_TOOL_NAME) &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      const scope = typeof filePath === 'string' ? memoryScopeOf(filePath) : null
      if (scope !== null && !appendOnly.includes(scope)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      if (scope !== null) {
        return onlyAdds(tool.name, input, filePath as string)
          ? { behavior: 'allow' as const, updatedInput: input }
          : denyMemoryTool(
              tool,
              `the ${scope} memory dir is append-only in this run: add a memory or a line, never remove or rewrite one — leave a ${scope} memory this project contradicts as it is, and report it`,
            )
      }
    }

    const where = getMemoryDirs()
      .map(dir => withoutTrailingSep(dir.root))
      .join(', ')
    return denyMemoryTool(
      tool,
      `only ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME}, and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} within ${where} are allowed`,
    )
  }
}

/**
 * The extraction fork's gate: append-only on the global dir, as the dream's
 * is — a background run in one project never rewrites or removes a memory
 * every project reads.
 */
export function createExtractionCanUseTool(): CanUseToolFn {
  return createMemoryCanUseTool(['global'])
}

// ============================================================================
// Fresh agent on another model
// ============================================================================

type FreshAgent = { model: string; effortValue: EffortValue }

/**
 * CLAUDIN_EXTRACT_MEMORIES_MODEL — an alias such as `haiku`, or a model id —
 * runs the extraction as a fresh agent on that model, at
 * CLAUDIN_EXTRACT_MEMORIES_EFFORT (default high), instead of a fork of the
 * main loop on the session's model. Unset, the default, keeps the fork. An
 * experiment, measured by scripts/bench/ab/extract-memories-ab.ts: Haiku 5.5
 * at high cost 94% less per extraction there, but skipped the user-profile
 * memory in 2 of 15 runs (the fork: 0 of 35); at xhigh, 92% less and 15 of
 * 15, at twice the fork's time per request. Rejected as a default on
 * 2026-10-10 (team memory decisions/extract-memories-haiku-rejected).
 */
function freshAgentFromEnv(): FreshAgent | null {
  const spec = process.env.CLAUDIN_EXTRACT_MEMORIES_MODEL?.trim()
  if (!spec) return null
  return {
    model: parseUserSpecifiedModel(spec),
    effortValue:
      parseEffortValue(process.env.CLAUDIN_EXTRACT_MEMORIES_EFFORT) ?? 'high',
  }
}

/**
 * The messages a fresh extraction agent reads: those after the cursor, from
 * the first human turn on, so no tool_result arrives without its tool_use.
 * The whole conversation when the cursor is unset or gone (compaction).
 */
export function messagesSinceCursor(
  messages: Message[],
  sinceUuid: string | undefined,
): Message[] {
  const cursor =
    sinceUuid === undefined ? -1 : messages.findIndex(m => m.uuid === sinceUuid)
  const start = messages.findIndex((m, i) => i > cursor && isHumanTurn(m))
  return start < 0 ? [] : messages.slice(start)
}

/**
 * The runForkedAgent params of a fresh agent: the main loop's system prompt
 * and tools, but a different model shares none of its prompt cache, so it
 * reads only the messages since the last extraction.
 */
export function freshAgentParams(
  params: CacheSafeParams,
  sinceUuid: string | undefined,
  { model, effortValue }: FreshAgent,
): { cacheSafeParams: CacheSafeParams; overrides: SubagentContextOverrides } {
  const parent = params.toolUseContext
  return {
    cacheSafeParams: {
      ...params,
      forkContextMessages: messagesSinceCursor(params.forkContextMessages, sinceUuid),
    },
    overrides: {
      // With an agentType, a turn calls options.mainLoopModel instead of the
      // session's model (turnModel.ts).
      agentType: 'extract_memories',
      options: { ...parent.options, mainLoopModel: model },
      getAppState: () => {
        const state = parent.getAppState()
        return {
          ...state,
          effortValue,
          toolPermissionContext: {
            ...state.toolPermissionContext,
            shouldAvoidPermissionPrompts: true,
          },
        }
      },
    },
  }
}

// ============================================================================
// Extract file paths from agent output
// ============================================================================

/** The absolute paths a content block writes; empty for anything but a write tool_use. */
function blockWrittenPaths(block: {
  type: string
  name?: string
  input?: unknown
}): string[] {
  return block.type === 'tool_use' ? writtenPathsOf(block.input, getCwd()) : []
}

function extractWrittenPaths(agentMessages: Message[]): string[] {
  const paths: string[] = []
  for (const message of agentMessages) {
    if (message.type !== 'assistant') {
      continue
    }
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      paths.push(...blockWrittenPaths(block))
    }
  }
  return uniq(paths)
}

/** How many of `paths` each memory directory holds; a path in none counts as private, as it always did. */
export function memoryCountsOf(paths: readonly string[]): Partial<Record<MemoryScope, number>> {
  const counts: Partial<Record<MemoryScope, number>> = {}
  for (const path of paths) {
    const scope = memoryScopeOf(path) ?? 'private'
    counts[scope] = (counts[scope] ?? 0) + 1
  }
  return counts
}

/**
 * The manifest of what is already saved, so the agent updates a memory
 * instead of duplicating it. One scan per directory that is not inside
 * another (the private scan covers the team dir in it); the scan lists paths
 * relative to the directory it walked, so each list but a lone private one
 * says which directory it is.
 */
export async function existingMemoryManifest(
  dirs: readonly MemoryDir[],
): Promise<string> {
  const signal = createAbortController().signal
  const tops = dirs.filter(dir => !dirs.some(other => other !== dir && dir.root.startsWith(other.root)))
  const lists: { dir: MemoryDir; manifest: string }[] = []
  for (const dir of tops) {
    const manifest = formatMemoryManifest(await scanMemoryFiles(dir.root, signal))
    if (manifest !== '') lists.push({ dir, manifest })
  }
  if (lists.length === 1 && lists[0]!.dir.scope === 'private') return lists[0]!.manifest
  return lists
    .map(({ dir, manifest }) => `In the ${dir.scope} dir \`${dir.root}\`:\n${manifest}`)
    .join('\n\n')
}

// ============================================================================
// Initialization & Closure-scoped State
// ============================================================================

type AppendSystemMessageFn = (
  msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
) => void

/** The active extractor function, set by initExtractMemories(). */
let extractor:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

/** The active drain function, set by initExtractMemories(). No-op until init. */
let drainer: (timeoutMs?: number) => Promise<void> = async () => {}

/**
 * Initialize the memory extraction system.
 * Creates a fresh closure that captures all mutable state (cursor position,
 * overlap guard, pending context). Call once at startup alongside
 * initConfidenceRating/initPromptCoaching, or per-test in beforeEach.
 */
export function initExtractMemories(): void {
  // --- Closure-scoped mutable state ---

  /** Every promise handed out by the extractor that hasn't settled yet.
   *  Coalesced calls that stash-and-return add fast-resolving promises
   *  (harmless); the call that starts real work adds a promise covering the
   *  full trailing-run chain via runExtraction's recursive finally. */
  const inFlightExtractions = new Set<Promise<void>>()

  /** UUID of the last message processed — cursor so each run only
   *  considers messages added since the previous extraction. */
  let lastMemoryMessageUuid: string | undefined

  /** True while runExtraction is executing — prevents overlapping runs. */
  let inProgress = false

  /** Counts eligible turns since the last extraction run. Resets to 0 after each run. */
  let turnsSinceLastExtraction = 0

  /** loopKey we last fired a repeated-error extraction for, and the human turn
   *  it was in — together they form the "per loop-key + new human turn" cooldown
   *  so a still-stuck agent doesn't fork an extraction every single turn. */
  let lastFiredLoopKey: string | undefined
  let lastLoopTurnUuid: string | undefined

  /** When a call arrives during an in-progress run, we stash the context here
   *  and run one trailing extraction after the current one finishes. */
  let pendingContext:
    | {
        context: REPLHookContext
        appendSystemMessage?: AppendSystemMessageFn
      }
    | undefined

  // --- Inner extraction logic ---

  async function runExtraction({
    context,
    appendSystemMessage,
    isTrailingRun,
  }: {
    context: REPLHookContext
    appendSystemMessage?: AppendSystemMessageFn
    isTrailingRun?: boolean
  }): Promise<void> {
    const { messages } = context
    const newMessageCount = countModelVisibleMessagesSince(
      messages,
      lastMemoryMessageUuid,
    )

    // Mutual exclusion: when the main agent wrote memories, skip the
    // forked agent and advance the cursor past this range so the next
    // extraction only considers messages after the main agent's write.
    if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
      logForDebugging(
        '[extractMemories] skipping — conversation already wrote to memory files',
      )
      const lastMessage = messages.at(-1)
      if (lastMessage?.uuid) {
        lastMemoryMessageUuid = lastMessage.uuid
      }
      return
    }

    // Repeated-error loop trigger: when the agent is stuck repeating the same
    // failing action, fire an extraction NOW (bypassing the turn throttle) so
    // the lesson is captured as a `feedback` memory while it's fresh. The
    // per-loopKey + per-human-turn cooldown stops it firing every stuck turn.
    // Best-effort: skipped on trailing/coalesced runs (a loop that overlaps an
    // in-flight extraction is simply caught by the next routine extraction).
    const loop =
      !isTrailingRun && isLoopTriggerEnabled()
        ? detectRepeatedErrorLoop(messages)
        : null
    const loopFires =
      loop !== null &&
      (loop.loopKey !== lastFiredLoopKey ||
        loop.userTurnUuid !== lastLoopTurnUuid)
    const loopHint = loopFires
      ? buildLoopHint(loop!.toolName, loop!.repeatCount)
      : undefined
    if (loopFires) {
      lastFiredLoopKey = loop!.loopKey
      lastLoopTurnUuid = loop!.userTurnUuid
      logForDebugging(
        `[extractMemories] repeated-error loop on ${loop!.toolName} (${loop!.repeatCount}×) — forcing extraction`,
      )
    }

    // Append-only on the global dir, like the dream's
    const canUseTool = createExtractionCanUseTool()
    const cacheSafeParams = createCacheSafeParams(context)

    // Only run extraction every N eligible turns (getExtractionTurnInterval).
    // Trailing extractions (from stashed contexts) skip this check since they
    // process already-committed work that should not be throttled. A loop-fire
    // also bypasses the throttle (we want the lesson promptly) but still resets
    // the counter below, so it doubles as the routine extraction for cadence.
    if (!isTrailingRun && loopHint === undefined) {
      turnsSinceLastExtraction++
      if (turnsSinceLastExtraction < getExtractionTurnInterval()) {
        return
      }
    }
    turnsSinceLastExtraction = 0

    inProgress = true
    const startTime = Date.now()
    try {
      logForDebugging(
        `[extractMemories] starting — ${newMessageCount} new messages`,
      )

      // Pre-inject the memory directory manifest so the agent doesn't spend
      // a turn on `ls` (memoryScan.ts, frontmatter only).
      // Placed after the throttle gate so skipped turns don't pay the scan cost.
      const existingMemories = await existingMemoryManifest(getMemoryDirs())
      const globalDir = getMemoryDir('global')?.root ?? null

      // The MEMORY.md index is always in the system prompt now that the
      // per-turn relevance recall is gone, so the extractor is always told to
      // keep it current.
      const userPrompt = buildExtractCombinedPrompt(
        newMessageCount,
        existingMemories,
        loopHint,
        globalDir,
      )

      const freshAgent = freshAgentFromEnv()
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: userPrompt })],
        ...(freshAgent
          ? freshAgentParams(cacheSafeParams, lastMemoryMessageUuid, freshAgent)
          : { cacheSafeParams }),
        canUseTool,
        querySource: 'extract_memories',
        forkLabel: 'extract_memories',
        // The extractMemories subagent does not need to record to transcript.
        // Doing so can create race conditions with the main thread.
        skipTranscript: true,
        // Well-behaved extractions complete in 2-4 turns (read → write).
        // A hard cap prevents verification rabbit-holes from burning turns.
        maxTurns: 5,
      })

      // Advance the cursor only after a successful run. If the agent errors
      // out (caught below), the cursor stays put so those messages are
      // reconsidered on the next extraction.
      const lastMessage = messages.at(-1)
      if (lastMessage?.uuid) {
        lastMemoryMessageUuid = lastMessage.uuid
      }

      const writtenPaths = extractWrittenPaths(result.messages)
      const turnCount = count(result.messages, m => m.type === 'assistant')

      const totalInput =
        result.totalUsage.input_tokens +
        result.totalUsage.cache_creation_input_tokens +
        result.totalUsage.cache_read_input_tokens
      const hitPct =
        totalInput > 0
          ? (
              (result.totalUsage.cache_read_input_tokens / totalInput) *
              100
            ).toFixed(1)
          : '0.0'
      logForDebugging(
        `[extractMemories] finished — ${writtenPaths.length} files written, cache: read=${result.totalUsage.cache_read_input_tokens} create=${result.totalUsage.cache_creation_input_tokens} input=${result.totalUsage.input_tokens} (${hitPct}% hit)`,
      )

      if (writtenPaths.length > 0) {
        logForDebugging(
          `[extractMemories] memories saved: ${writtenPaths.join(', ')}`,
        )
      } else {
        logForDebugging('[extractMemories] no memories saved this run')
      }

      // Index file updates are mechanical — the agent touches MEMORY.md to add
      // a topic link, but the user-visible "memory" is the topic file itself.
      const memoryPaths = writtenPaths.filter(
        p => basename(p) !== ENTRYPOINT_NAME,
      )

      logForDebugging(
        `[extractMemories] writtenPaths=${writtenPaths.length} memoryPaths=${memoryPaths.length} appendSystemMessage defined=${appendSystemMessage != null}`,
      )
      if (memoryPaths.length > 0 && getGlobalConfig().notifyMemorySaved === true) {
        appendSystemMessage?.({
          ...createMemorySavedMessage(memoryPaths),
          memoryCounts: memoryCountsOf(memoryPaths),
        })
      }
    } catch (error) {
      // Extraction is best-effort — log but don't notify on error
      logForDebugging(`[extractMemories] error: ${error}`)
    } finally {
      inProgress = false

      // If a call arrived while we were running, run a trailing extraction
      // with the latest stashed context. The trailing run will compute its
      // newMessageCount relative to the cursor we just advanced — so it only
      // picks up messages added between the two calls, not the full history.
      const trailing = pendingContext
      pendingContext = undefined
      if (trailing) {
        logForDebugging(
          '[extractMemories] running trailing extraction for stashed context',
        )
        await runExtraction({
          context: trailing.context,
          appendSystemMessage: trailing.appendSystemMessage,
          isTrailingRun: true,
        })
      }
    }
  }

  // --- Public entry point (captured by extractor) ---

  async function executeExtractMemoriesImpl(
    context: REPLHookContext,
    appendSystemMessage?: AppendSystemMessageFn,
  ): Promise<void> {
    // Only run for the main agent, not subagents
    if (context.toolUseContext.agentId) {
      return
    }

    if (!isExtractMemoriesEnabled()) {
      return
    }

    // Check auto-memory is enabled
    if (!isAutoMemoryEnabled()) {
      return
    }

    // Skip in remote mode
    if (getIsRemoteMode()) {
      return
    }

    // If an extraction is already in progress, stash this context for a
    // trailing run (overwrites any previously stashed context — only the
    // latest matters since it has the most messages).
    if (inProgress) {
      logForDebugging(
        '[extractMemories] extraction in progress — stashing for trailing run',
      )
      pendingContext = { context, appendSystemMessage }
      return
    }

    await runExtraction({ context, appendSystemMessage })
  }

  extractor = async (context, appendSystemMessage) => {
    const p = executeExtractMemoriesImpl(context, appendSystemMessage)
    inFlightExtractions.add(p)
    try {
      await p
    } finally {
      inFlightExtractions.delete(p)
    }
  }

  // A `-p` run extracts only under CLAUDIN_EXTRACT_MEMORIES_HEADLESS, which
  // asks to see the extraction through: an interactive one never cuts it, and
  // a fresh agent at xhigh has spent 56s on a single request.
  drainer = async (timeoutMs = 5 * 60_000) => {
    if (inFlightExtractions.size === 0) return
    await Promise.race([
      Promise.all(inFlightExtractions).catch(() => {}),
      // eslint-disable-next-line no-restricted-syntax -- sleep() has no .unref(); timer must not block exit
      new Promise<void>(r => setTimeout(r, timeoutMs).unref()),
    ])
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run memory extraction at the end of a query loop.
 * Called fire-and-forget from handleStopHooks, alongside prompt suggestion/coaching.
 * No-ops until initExtractMemories() has been called.
 */
export async function executeExtractMemories(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  await extractor?.(context, appendSystemMessage)
}

/**
 * Awaits all in-flight extractions (including trailing stashed runs) with a
 * soft timeout. Called by print.ts after the response is flushed but before
 * gracefulShutdownSync, so the forked agent completes before the 5s shutdown
 * failsafe kills it. No-op until initExtractMemories() has been called.
 */
export async function drainPendingExtraction(
  timeoutMs?: number,
): Promise<void> {
  await drainer(timeoutMs)
}
