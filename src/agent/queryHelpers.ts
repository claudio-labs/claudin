import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/platform/bootstrap/state.js'
import type { SDKMessage } from 'src/platform/entrypoints/agentSdkTypes.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { runTools } from 'src/agent/tools/toolOrchestration.js'
import { findToolByName, type Tool, type Tools } from 'src/tools/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { isResubmitSentinel, parsePatch } from 'src/tools/ApplyPatchTool/patchFormat.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import type { Input as FileReadInput } from 'src/tools/FileReadTool/FileReadTool.js'
import { splitBatchReadResult } from 'src/tools/FileReadTool/batchResult.js'
import {
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
} from 'src/tools/FileReadTool/prompt.js'
import {
  isBatchReadInput,
  readPathsOf,
  recordedReadTargets,
  symbolsOf,
} from 'src/tools/FileReadTool/readMulti.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import type { Message } from 'src/shared/types/message.js'
import type { OrphanedPermission } from 'src/shared/types/textInputTypes.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import { getFileModificationTime, stripLineNumberPrefix } from 'src/shared/fs/file.js'
import { readFileSyncWithMetadata } from 'src/shared/fs/fileRead.js'
import {
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
  type FileState,
} from 'src/shared/fs/fileStateCache.js'
import { isNotEmptyMessage, normalizeMessages } from 'src/agent/messages/messages.js'
import { expandPath } from 'src/shared/fs/path.js'
import type {
  inputSchema as permissionToolInputSchema,
  outputSchema as permissionToolOutputSchema,
} from 'src/permissions/PermissionPromptToolResultSchema.js'
import type { ProcessUserInputContext } from 'src/agent/input/processUserInput.js'
import { recordTranscript } from 'src/sessions/sessionStorage.js'

export type PermissionPromptTool = Tool<
  ReturnType<typeof permissionToolInputSchema>,
  ReturnType<typeof permissionToolOutputSchema>
>

// Small cache size for ask operations which typically access few files
// during permission prompts or limited tool operations
const ASK_READ_FILE_STATE_CACHE_SIZE = 10

// A rendered file line, as `addLineNumbers` (shared/fs/file.ts) writes it.
// Kept in step with `stripLineNumberPrefix` there.
const NUMBERED_LINE_RE = /^\s*(\d+)[\u2192\t](.*)$/

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type NumberedRun = { offset: number; content: string }

/**
 * The file bytes a Read tool_result put in front of the model, read back off
 * its `N→` prefixes: each run of numbered lines, in order — its first number
 * the offset, its lines the content. A run stops at the first unnumbered
 * line, so trailing notes are not taken for file content. A Read shows one
 * run; a batch's symbol list shows one per body, a blank line apart. None at
 * all for an outline, the auto-outline pivot, an image, a "shorter than the
 * offset" warning, the dedup stub — none of those showed the model any line
 * it could edit.
 */
function numberedRuns(text: string): NumberedRun[] {
  const runs: { offset: number; lines: string[] }[] = []
  let current: { offset: number; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    const match = NUMBERED_LINE_RE.exec(line)
    if (!match) {
      current = undefined
      continue
    }
    if (!current) {
      current = { offset: Number(match[1]), lines: [] }
      runs.push(current)
    }
    current.lines.push(match[2]!)
  }
  return runs.map(run => ({ offset: run.offset, content: run.lines.join('\n') }))
}

/** The one run a single Read shows; null when it shows none. */
function parseNumberedReadResult(text: string): NumberedRun | null {
  return numberedRuns(text)[0] ?? null
}

/** Every path a Patch call wrote or removed, from its own input. */
function applyPatchTargets(
  patchText: string,
  cwd: string,
): { written: string[]; deleted: string[] } {
  const written: string[] = []
  const deleted: string[] = []
  let hunks
  try {
    hunks = parsePatch(patchText).hunks
  } catch (e) {
    // A patch the tool itself rejected as malformed wrote nothing.
    logForDebugging(`resume: skipping unparseable Patch input: ${e}`)
    return { written, deleted }
  }
  for (const hunk of hunks) {
    if (hunk.type === 'delete') {
      deleted.push(expandPath(hunk.path, cwd))
    } else if (hunk.type === 'update' && hunk.movePath) {
      deleted.push(expandPath(hunk.path, cwd))
      written.push(expandPath(hunk.movePath, cwd))
    } else {
      written.push(expandPath(hunk.path, cwd))
    }
  }
  return { written, deleted }
}

/**
 * Checks if the result should be considered successful based on the last message.
 * Returns true if:
 * - Last message is assistant with text/thinking content
 * - Last message is user with only tool_result blocks
 * - Last message is the user prompt but the API completed with end_turn
 *   (model chose to emit no content blocks)
 */
export function isResultSuccessful(
  message: Message | undefined,
  stopReason: string | null = null,
): message is Message {
  if (!message) return false

  if (message.type === 'assistant') {
    const lastContent = last(message.message.content)
    return (
      lastContent?.type === 'text' ||
      lastContent?.type === 'thinking' ||
      lastContent?.type === 'redacted_thinking'
    )
  }

  if (message.type === 'user') {
    // Check if all content blocks are tool_result type
    const content = message.message.content
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(block => 'type' in block && block.type === 'tool_result')
    ) {
      return true
    }
  }

  // Carve-out: API completed (message_delta set stop_reason) but yielded
  // no assistant content — last(messages) is still this turn's prompt.
  // claude.ts:2026 recognizes end_turn-with-zero-content-blocks as
  // legitimate and passes through without throwing. Observed on
  // task_notification drain turns: model returns stop_reason=end_turn,
  // outputTokens=4, textContentLength=0 — it saw the subagent result
  // and decided nothing needed saying. Without this, QueryEngine emits
  // error_during_execution with errors[] = the entire process's
  // accumulated logError() buffer. Covers both string-content and
  // text-block-content user prompts, and any other non-passing shape.
  return stopReason === 'end_turn'
}

// Track last sent time for tool progress messages per tool use ID
// Keep only the last 100 entries to prevent unbounded growth
const MAX_TOOL_PROGRESS_TRACKING_ENTRIES = 100
const TOOL_PROGRESS_THROTTLE_MS = 30000
const toolProgressLastSentTime = new Map<string, number>()

/**
 * Insert a tool progress key with FIFO eviction at the cap. Extracted from
 * the bash/powershell progress branch so the cap invariant is testable
 * without spinning up the full progress pipeline (which is gated behind
 * CLAUDE_CODE_REMOTE / CLAUDE_CODE_CONTAINER_ID env vars).
 */
function recordToolProgress(key: string, now: number): void {
  if (toolProgressLastSentTime.size >= MAX_TOOL_PROGRESS_TRACKING_ENTRIES) {
    const firstKey = toolProgressLastSentTime.keys().next().value
    if (firstKey !== undefined) {
      toolProgressLastSentTime.delete(firstKey)
    }
  }
  toolProgressLastSentTime.set(key, now)
}

/** Test-only accessor for the toolProgressLastSentTime map size. */
export function __TEST_ONLY_getToolProgressMapSize(): number {
  return toolProgressLastSentTime.size
}

/** Test-only insertion for cacheBoundsInvariants test. Same code path as
 * the production callsite below. */
export function __TEST_ONLY_recordToolProgress(key: string): void {
  recordToolProgress(key, Date.now())
}

/** Test-only reset. */
export function __TEST_ONLY_resetToolProgressMap(): void {
  toolProgressLastSentTime.clear()
}

export function* normalizeMessage(message: Message): Generator<SDKMessage> {
  switch (message.type) {
    case 'assistant':
      for (const _ of normalizeMessages([message])) {
        // Skip empty messages (e.g., "(no content)") that shouldn't be output to SDK
        if (!isNotEmptyMessage(_)) {
          continue
        }
        yield {
          type: 'assistant',
          message: { ..._.message, stop_details: null },
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          error: _.error,
        } as unknown as SDKMessage
      }
      return
    case 'progress':
      if (
        message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress'
      ) {
        for (const _ of normalizeMessages([message.data.message])) {
          switch (_.type) {
            case 'assistant':
              // Skip empty messages (e.g., "(no content)") that shouldn't be output to SDK
              if (!isNotEmptyMessage(_)) {
                break
              }
              yield {
                type: 'assistant',
                message: { ..._.message, stop_details: null },
                parent_tool_use_id: message.parentToolUseID,
                session_id: getSessionId(),
                uuid: _.uuid,
                error: _.error,
              } as unknown as SDKMessage
              break
            case 'user':
              yield {
                type: 'user',
                message: _.message,
                parent_tool_use_id: message.parentToolUseID,
                session_id: getSessionId(),
                uuid: _.uuid,
                timestamp: _.timestamp,
                isSynthetic: _.isMeta || _.isVisibleInTranscriptOnly,
                tool_use_result: _.mcpMeta
                  ? { content: _.toolUseResult, ..._.mcpMeta }
                  : _.toolUseResult,
              }
              break
          }
        }
      } else if (
        message.data.type === 'bash_progress' ||
        message.data.type === 'powershell_progress'
      ) {
        // Filter bash progress to send only one per minute
        // Only emit for Claude Code Remote for now
        if (
          !isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
          !process.env.CLAUDE_CODE_CONTAINER_ID
        ) {
          break
        }

        // Use parentToolUseID as the key since toolUseID changes for each progress message
        const trackingKey = message.parentToolUseID
        const now = Date.now()
        const lastSent = toolProgressLastSentTime.get(trackingKey) || 0
        const timeSinceLastSent = now - lastSent

        // Send if at least 30 seconds have passed since last update
        if (timeSinceLastSent >= TOOL_PROGRESS_THROTTLE_MS) {
          recordToolProgress(trackingKey, now)
          yield {
            type: 'tool_progress',
            tool_use_id: message.toolUseID,
            tool_name:
              message.data.type === 'bash_progress' ? 'Bash' : 'PowerShell',
            parent_tool_use_id: message.parentToolUseID,
            elapsed_time_seconds: message.data.elapsedTimeSeconds,
            task_id: message.data.taskId,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
        }
      }
      break
    case 'user':
      for (const _ of normalizeMessages([message])) {
        yield {
          type: 'user',
          message: _.message,
          parent_tool_use_id: null,
          session_id: getSessionId(),
          uuid: _.uuid,
          timestamp: _.timestamp,
          isSynthetic: _.isMeta || _.isVisibleInTranscriptOnly,
          tool_use_result: _.mcpMeta
            ? { content: _.toolUseResult, ..._.mcpMeta }
            : _.toolUseResult,
        }
      }
      return
    default:
    // yield nothing
  }
}

export async function* handleOrphanedPermission(
  orphanedPermission: OrphanedPermission,
  tools: Tools,
  mutableMessages: Message[],
  processUserInputContext: ProcessUserInputContext,
): AsyncGenerator<SDKMessage, void, unknown> {
  const persistSession = !isSessionPersistenceDisabled()
  const { permissionResult, assistantMessage } = orphanedPermission
  const { toolUseID } = permissionResult

  if (!toolUseID) {
    return
  }

  const content = assistantMessage.message.content
  let toolUseBlock: ToolUseBlock | undefined
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.id === toolUseID) {
        toolUseBlock = block as ToolUseBlock
        break
      }
    }
  }

  if (!toolUseBlock) {
    return
  }

  const toolName = toolUseBlock.name
  const toolInput = toolUseBlock.input

  const toolDefinition = findToolByName(tools, toolName)
  if (!toolDefinition) {
    return
  }

  // Create ToolUseBlock with the updated input if permission was allowed
  let finalInput = toolInput
  if (permissionResult.behavior === 'allow') {
    if (permissionResult.updatedInput !== undefined) {
      finalInput = permissionResult.updatedInput
    } else {
      logForDebugging(
        `Orphaned permission for ${toolName}: updatedInput is undefined, falling back to original tool input`,
        { level: 'warn' },
      )
    }
  }
  const finalToolUseBlock: ToolUseBlock = {
    ...toolUseBlock,
    input: finalInput,
  }

  const canUseTool: CanUseToolFn = async () => ({
    ...permissionResult,
    decisionReason: {
      type: 'mode',
      mode: 'default' as const,
    },
  })

  // Add the assistant message with tool_use to messages BEFORE executing
  // so the conversation history is complete (tool_use -> tool_result).
  //
  // On CCR resume, mutableMessages is seeded from the transcript and may already
  // contain this tool_use. Pushing again would make normalizeMessagesForAPI merge
  // same-ID assistants (concatenating content) and produce a duplicate tool_use
  // ID, which the API rejects with "tool_use ids must be unique".
  //
  // Check for the specific tool_use_id rather than message.id: streaming yields
  // each content block as a separate AssistantMessage sharing one message.id, so
  // a [text, tool_use] response lands as two entries. filterUnresolvedToolUses may
  // strip the tool_use entry but keep the text one; an id-based check would then
  // wrongly skip the push while runTools below still executes, orphaning the result.
  const alreadyPresent = mutableMessages.some(
    m =>
      m.type === 'assistant' &&
      Array.isArray(m.message.content) &&
      m.message.content.some(
        b => b.type === 'tool_use' && 'id' in b && b.id === toolUseID,
      ),
  )
  if (!alreadyPresent) {
    mutableMessages.push(assistantMessage)
    if (persistSession) {
      await recordTranscript(mutableMessages)
    }
  }

  const sdkAssistantMessage: SDKMessage = {
    ...assistantMessage,
    message: { ...assistantMessage.message, stop_details: null },
    session_id: getSessionId(),
    parent_tool_use_id: null,
  } as unknown as SDKMessage
  yield sdkAssistantMessage

  // Execute the tool - errors are handled internally by runToolUse
  for await (const update of runTools(
    [finalToolUseBlock],
    [assistantMessage],
    canUseTool,
    processUserInputContext,
  )) {
    if (update.message) {
      mutableMessages.push(update.message)
      if (persistSession) {
        await recordTranscript(mutableMessages)
      }

      const sdkMessage: SDKMessage = {
        ...update.message,
        session_id: getSessionId(),
        parent_tool_use_id: null,
      } as SDKMessage

      yield sdkMessage
    }
  }
}

// Create a function to extract read files from messages
export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = ASK_READ_FILE_STATE_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)

  // First pass: find all Read/Write/Edit/Patch uses in assistant messages
  // toolUseId -> { filePath, ranged }. A ranged Read (offset/limit/symbol)
  // is restored as the slice it showed, not skipped: a file range-read before
  // a /resume used to come back "never read" (queryHelpers used to drop these).
  const fileReadToolUseIds = new Map<
    string,
    { filePath: string; ranged: boolean }
  >()
  // toolUseId -> the paths a batch Read named (readMulti.ts). `ranged` is its
  // symbol, which applies to every file, as offset/limit/symbol do to one.
  const batchReadToolUseIds = new Map<
    string,
    { paths: string[]; ranged: boolean }
  >()
  const fileWriteToolUseIds = new Map<
    string,
    { filePath: string; content: string }
  >() // toolUseId -> { filePath, content }
  const fileEditToolUseIds = new Map<string, string>() // toolUseId -> filePath
  const applyPatchToolUseIds = new Map<string, string>() // toolUseId -> patchText
  const bashToolUseIds = new Set<string>()
  // `*** Resubmit` applies the patch refused one Patch call earlier.
  let lastPatchText: string | undefined

  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const content of message.message.content) {
        if (
          content.type === 'tool_use' &&
          content.name === FILE_READ_TOOL_NAME
        ) {
          // Extract file_path from the tool use input
          const input = content.input as FileReadInput | undefined
          // The stored input is the model's own: read it as the tool did, so
          // Codex's `file_paths: null` beside one path stays a single Read.
          const targets = recordedReadTargets(input)
          // An outline shows structure, not bytes; nothing to restore — for
          // a batch too, whose view applies to every file.
          if (isBatchReadInput(targets)) {
            // Several files, or several symbols of one: each file's section
            // of the result is restored as a Read of that file would be.
            if (input?.view !== 'outline') {
              batchReadToolUseIds.set(content.id, {
                paths: readPathsOf(targets),
                ranged: symbolsOf(targets).length > 0,
              })
            }
          } else if (input?.file_path && input.view !== 'outline') {
            // Normalize to absolute path for consistent cache lookups
            const absolutePath = expandPath(input.file_path, cwd)
            fileReadToolUseIds.set(content.id, {
              filePath: absolutePath,
              ranged:
                input.offset !== undefined ||
                input.limit !== undefined ||
                input.symbol !== undefined,
            })
          }
        } else if (
          content.type === 'tool_use' &&
          content.name === FILE_WRITE_TOOL_NAME
        ) {
          // Extract file_path and content from the Write tool use input
          const input = content.input as
            | { file_path?: string; content?: string }
            | undefined
          if (input?.file_path && input?.content) {
            // Normalize to absolute path for consistent cache lookups
            const absolutePath = expandPath(input.file_path, cwd)
            fileWriteToolUseIds.set(content.id, {
              filePath: absolutePath,
              content: input.content,
            })
          }
        } else if (
          content.type === 'tool_use' &&
          content.name === FILE_EDIT_TOOL_NAME
        ) {
          // Edit's input has old_string/new_string, not the resulting content.
          // Track the path so the second pass can read current disk state.
          const input = content.input as { file_path?: string } | undefined
          if (input?.file_path) {
            const absolutePath = expandPath(input.file_path, cwd)
            fileEditToolUseIds.set(content.id, absolutePath)
          }
        } else if (
          content.type === 'tool_use' &&
          content.name === APPLY_PATCH_TOOL_NAME
        ) {
          const input = content.input as { patchText?: string } | undefined
          if (input?.patchText) {
            const patchText = isResubmitSentinel(input.patchText)
              ? lastPatchText
              : input.patchText
            if (patchText) applyPatchToolUseIds.set(content.id, patchText)
            if (!isResubmitSentinel(input.patchText)) lastPatchText = input.patchText
          }
        } else if (
          content.type === 'tool_use' &&
          content.name === BASH_TOOL_NAME
        ) {
          bashToolUseIds.add(content.id)
        }
      }
    }
  }

  // Paths whose current entry came from a Read (not a write tool). Slices of
  // one file accumulate through `FileStateCache.set` → `carrySeenRanges`,
  // which only carries when the timestamps agree — in a live session that is
  // the mtime, here it is the message time, so equalize it before the set. A
  // write tool's entry is left alone: it stands for the whole post-write
  // file, and a later slice must not be joined to bytes from before it.
  const readAuthored = new Set<string>()

  /** Post-write state of a file a write tool touched, read from disk now. */
  function cacheFromDisk(filePath: string): void {
    try {
      const { content: diskContent } = readFileSyncWithMetadata(filePath)
      cache.set(filePath, {
        content: diskContent,
        timestamp: getFileModificationTime(filePath),
        offset: undefined,
        limit: undefined,
      })
      readAuthored.delete(filePath)
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) {
        throw e
      }
      // File deleted or inaccessible since the write — skip
    }
  }

  /**
   * A file a Bash `cat` was credited with (creditShownFiles.ts), as the credit
   * stored it — whole, and exempt from Read's dedup stub, since no Read showed
   * it. Only while it is unchanged since the result came back: written after,
   * the file on disk is not the one the model saw.
   */
  function cacheCreditFromDisk(filePath: string, answeredAt: number): void {
    try {
      const timestamp = getFileModificationTime(filePath)
      if (timestamp > answeredAt) return
      const { content: diskContent } = readFileSyncWithMetadata(filePath)
      cache.set(filePath, {
        content: diskContent,
        timestamp,
        offset: 1,
        limit: undefined,
        dedupExempt: true,
      })
      readAuthored.delete(filePath)
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) {
        throw e
      }
      // File deleted or inaccessible since the read — skip
    }
  }

  /**
   * What a Read showed of `filePath`, as its entry: the slice `run` for a
   * ranged Read, the whole file otherwise. `shown` is the Read's text with
   * its system-reminder blocks removed; `run` is a numbered run of it.
   */
  function cacheShownRead(
    filePath: string,
    shown: string,
    run: NumberedRun,
    ranged: boolean,
    timestamp: number,
  ): void {
    const entry: FileState = ranged
      ? {
          // The slice as shown — untrimmed, or a leading blank
          // line would shift every line number after it.
          content: run.content,
          timestamp,
          offset: run.offset,
          limit: run.content.split('\n').length,
        }
      : {
          // Whole-file: the shape the write tools store, trimmed
          // as this path always has been.
          content: shown
            .split('\n')
            .map(stripLineNumberPrefix)
            .join('\n')
            .trim(),
          timestamp,
          offset: undefined,
          limit: undefined,
        }
    const prev = cache.get(filePath)
    if (prev && readAuthored.has(filePath)) {
      prev.timestamp = timestamp
    }
    cache.set(filePath, entry)
    readAuthored.add(filePath)
  }

  // Second pass: find corresponding tool results and extract content
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const content of message.message.content) {
        if (content.type === 'tool_result' && content.tool_use_id) {
          // Handle Read tool results
          const read = fileReadToolUseIds.get(content.tool_use_id)
          if (
            read &&
            typeof content.content === 'string' &&
            // Dedup stubs contain no file content — the earlier real Read
            // already cached it. Chronological last-wins would otherwise
            // overwrite the real entry with stub text.
            !content.content.startsWith(FILE_UNCHANGED_STUB) &&
            message.timestamp
          ) {
            // Remove system-reminder blocks from the content
            const processedContent = content.content.replace(
              SYSTEM_REMINDER_RE,
              '',
            )
            const parsed = parseNumberedReadResult(processedContent)
            // No numbered lines: an outline, an image, an error. Caching
            // that text as the file would let getChangedFiles diff against
            // it and the write tools edit from it.
            if (parsed) {
              cacheShownRead(
                read.filePath,
                processedContent,
                parsed,
                read.ranged,
                new Date(message.timestamp).getTime(),
              )
            }
          }

          // A batch Read: each file's section is the text a Read of that
          // file returns, restored by the same rule — its one numbered run
          // as the whole file, or, under a symbol, every run as a slice
          // (a symbol list shows one body each), which accumulate as the
          // slices of several ranged Reads do. A section with no numbered
          // line — the dedup stub, an outline, an error — restores nothing,
          // and the note lines after the last file are no file's content.
          const batch = batchReadToolUseIds.get(content.tool_use_id)
          if (
            batch &&
            typeof content.content === 'string' &&
            message.timestamp
          ) {
            const timestamp = new Date(message.timestamp).getTime()
            for (const section of splitBatchReadResult(
              content.content,
              batch.paths,
              cwd,
            )) {
              const shown = section.text.replace(SYSTEM_REMINDER_RE, '')
              const filePath = expandPath(section.path, cwd)
              const runs = numberedRuns(shown)
              if (batch.ranged) {
                for (const run of runs) {
                  cacheShownRead(filePath, shown, run, true, timestamp)
                }
              } else if (runs[0]) {
                cacheShownRead(filePath, shown, runs[0], false, timestamp)
              }
            }
          }

          // Handle Write tool results - use content from the tool input
          const writeToolData = fileWriteToolUseIds.get(content.tool_use_id)
          if (writeToolData && message.timestamp) {
            const timestamp = new Date(message.timestamp).getTime()
            cache.set(writeToolData.filePath, {
              content: writeToolData.content,
              timestamp,
              offset: undefined,
              limit: undefined,
            })
            readAuthored.delete(writeToolData.filePath)
          }

          // Handle Edit tool results — post-edit content isn't in the
          // tool_use input (only old_string/new_string) nor fully in the
          // result (only a snippet). Read from disk now, using actual mtime
          // so getChangedFiles's mtime check passes on the next turn.
          //
          // Callers seed the cache once at process start (print.ts --resume,
          // Cowork cold-restart per turn), so disk content at extraction time
          // IS the post-edit state. No dedup: processing every Edit preserves
          // last-wins semantics when Read/Write interleave (Edit→Read→Edit).
          const editFilePath = fileEditToolUseIds.get(content.tool_use_id)
          if (editFilePath && content.is_error !== true) {
            cacheFromDisk(editFilePath)
          }

          // Patch: same as Edit, for every file the patch named. Its
          // result text is a per-file summary, so disk is the only source.
          const patchText = applyPatchToolUseIds.get(content.tool_use_id)
          if (patchText && content.is_error !== true) {
            const { written, deleted } = applyPatchTargets(patchText, cwd)
            for (const filePath of deleted) {
              cache.delete(filePath)
              readAuthored.delete(filePath)
            }
            for (const filePath of written) {
              cacheFromDisk(filePath)
            }
          }

          // Bash: the files the read credit counted (CLAUDIN_BASH_READ_CREDIT),
          // named on the Out the result carries. The result text only says
          // how many; the paths are the tool's.
          if (
            bashToolUseIds.has(content.tool_use_id) &&
            content.is_error !== true &&
            message.timestamp
          ) {
            const answeredAt = new Date(message.timestamp).getTime()
            for (const filePath of creditedFilesOf(message.toolUseResult)) {
              cacheCreditFromDisk(filePath, answeredAt)
            }
          }
        }
      }
    }
  }

  return cache
}

/** The paths a Bash result's Out names as credited reads; none when it has no such field. */
function creditedFilesOf(toolUseResult: unknown): string[] {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return []
  const { creditedFiles } = toolUseResult as { creditedFiles?: unknown }
  if (!Array.isArray(creditedFiles)) return []
  return creditedFiles.filter((path): path is string => typeof path === 'string')
}

/**
 * Paths of the rules and CLAUDE.md files already injected into this history
 * as `nested_memory` attachments. The dedup set they are checked against lives
 * per engine and starts empty, so a resumed session re-injects every one of
 * them on the next matching Read unless it is seeded from here.
 */
export function extractNestedMemoryPathsFromMessages(
  messages: Message[],
): Set<string> {
  const paths = new Set<string>()
  for (const message of messages) {
    if (
      message.type === 'attachment' &&
      message.attachment.type === 'nested_memory'
    ) {
      paths.add(message.attachment.path)
    }
  }
  return paths
}

/**
 * Extract the top-level CLI tools used in BashTool calls from message history.
 * Returns a deduplicated set of command names (e.g. 'vercel', 'aws', 'git').
 */
export function extractBashToolsFromMessages(messages: Message[]): Set<string> {
  const tools = new Set<string>()
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const content of message.message.content) {
        if (content.type === 'tool_use' && content.name === BASH_TOOL_NAME) {
          const { input } = content
          if (
            typeof input !== 'object' ||
            input === null ||
            !('command' in input)
          )
            continue
          const cmd = extractCliName(
            typeof input.command === 'string' ? input.command : undefined,
          )
          if (cmd) {
            tools.add(cmd)
          }
        }
      }
    }
  }
  return tools
}

const STRIPPED_COMMANDS = new Set(['sudo'])

/**
 * Extract the actual CLI name from a bash command string, skipping
 * env var assignments (e.g. `FOO=bar vercel` → `vercel`) and prefixes
 * in STRIPPED_COMMANDS.
 */
function extractCliName(command: string | undefined): string | undefined {
  if (!command) return undefined
  const tokens = command.trim().split(/\s+/)
  for (const token of tokens) {
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    if (STRIPPED_COMMANDS.has(token)) continue
    return token
  }
  return undefined
}
