import type { UUID } from 'crypto'
import { relative } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { addInvokedSkill } from 'src/platform/bootstrap/state.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  CostStateEntry,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from 'src/shared/types/logs.js'
import type {
  AttachmentMessage,
  Message,
  NormalizedMessage,
  NormalizedUserMessage,
} from 'src/shared/types/message.js'
import { PERMISSION_MODES } from 'src/shared/types/permissions.js'
import {
  suppressNextBashGitInstructions,
  suppressNextSkillListing,
} from 'src/agent/attachments/attachments.js'
import {
  copyFileHistoryForResume,
  type FileHistorySnapshot,
} from 'src/shared/fs/fileHistory.js'
import { logError } from 'src/shared/log.js'
import { type APIProvider, getAPIProvider } from 'src/providers/model/providers.js'
import { normalizeLegacyToolName } from 'src/permissions/permissionRuleParser.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/agent/messages/messages.js'
import { copyPlanForResume } from 'src/agent/plans/plans.js'
import { processSessionStartHooks } from 'src/sessions/sessionStart.js'
import {
  buildConversationChain,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from 'src/sessions/sessionStorage.js'
import { latestByTimestamp } from 'src/sessions/resume/latest.js'
import { jsonStringify } from 'src/platform/slowOperations.js'

const MAX_RESUME_MESSAGE_BYTES = 8 * 1024 * 1024

const BYTES_PER_MIB = 1024 * 1024

function inMiB(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(1)
}

export class ResumeTranscriptTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
    readonly messageCount: number,
  ) {
    super(
      `This conversation is too large to resume (${inMiB(bytes)} MiB > ${inMiB(maxBytes)} MiB, ${messageCount} messages)`,
    )
    this.name = 'ResumeTranscriptTooLargeError'
  }
}

function assertResumeMessageSize(messages: Message[]): void {
  const bytes = Buffer.byteLength(jsonStringify(messages), 'utf8')
  if (bytes > MAX_RESUME_MESSAGE_BYTES) {
    throw new ResumeTranscriptTooLargeError(bytes, MAX_RESUME_MESSAGE_BYTES, messages.length)
  }
}

// --- readying: each step returns new messages and leaves its input alone -----------

type Attachment = AttachmentMessage['attachment']

/** The fields older builds wrote on file-like attachments. */
type FileLikeFields = {
  type: string
  displayPath?: unknown
  filename?: unknown
  path?: unknown
  skillDir?: unknown
}

const RENAMED_ATTACHMENT_KINDS: Readonly<Record<string, string>> = {
  new_file: 'file',
  new_directory: 'directory',
}

function migrateLegacyAttachmentTypes(message: Message): Message {
  if (message.type !== 'attachment') return message
  if (!message.attachment) {
    throw new Error(`Transcript attachment message ${message.uuid} carries no attachment`)
  }
  const fields = message.attachment as unknown as FileLikeFields
  const type = Object.hasOwn(RENAMED_ATTACHMENT_KINDS, fields.type) ? RENAMED_ATTACHMENT_KINDS[fields.type]! : fields.type
  const located = [fields.filename, fields.path, fields.skillDir].find(
    (candidate): candidate is string => typeof candidate === 'string',
  )
  const displayPath = fields.displayPath ?? (located === undefined ? undefined : relative(getCwd(), located))
  if (type === fields.type && displayPath === fields.displayPath) return message
  return { ...message, attachment: { ...fields, type, displayPath } as unknown as Attachment }
}

/**
 * Rewrites a renamed tool's old wire name (`apply_patch` → `Patch`) on the
 * tool_use blocks of a resumed transcript. The request path already sends the
 * canonical name — normalize.ts resolves tool aliases — but everything that
 * reads the in-memory history compares names: the read-state rebuild on
 * resume, the write collapse, /diff. Without this they would not see the
 * old calls at all.
 */
function migrateLegacyToolNames(message: Message): Message {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return message
  let renamedAny = false
  const content = message.message.content.map(block => {
    if (block.type !== 'tool_use') return block
    const name = normalizeLegacyToolName(block.name)
    if (name === block.name) return block
    renamedAny = true
    return { ...block, name }
  })
  return renamedAny ? { ...message, message: { ...message.message, content } } : message
}

const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set(PERMISSION_MODES)

/** A mode written by another build never reaches the session; the copy is cleared, not the caller's message. */
function withKnownPermissionMode(message: Message): Message {
  if (message.type !== 'user' || message.permissionMode === undefined) return message
  if (KNOWN_PERMISSION_MODES.has(message.permissionMode)) return message
  return { ...message, permissionMode: undefined }
}

function upgradeLegacyShapes(message: Message): Message {
  return withKnownPermissionMode(migrateLegacyToolNames(migrateLegacyAttachmentTypes(message)))
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/** Only these providers accept the thinking blocks of an earlier turn back. */
const PROVIDERS_KEEPING_THINKING: ReadonlySet<APIProvider> = new Set(['firstParty', 'bedrock', 'vertex', 'foundry'])

const THINKING_BLOCK_KINDS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])

function stripThinkingBlocks(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.flatMap((message): NormalizedMessage[] => {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return [message]
    const content = message.message.content.filter(block => !THINKING_BLOCK_KINDS.has(block.type))
    if (content.length === message.message.content.length) return [message]
    if (content.length === 0) return []
    return [{ ...message, message: { ...message.message, content } } as NormalizedMessage]
  })
}

/** Leaves out what the API would reject: unanswered calls, orphan or foreign thinking, blank replies. */
function keepWhatTheApiAccepts(messages: Message[]): Message[] {
  let kept = filterOrphanedThinkingOnlyMessages(filterUnresolvedToolUses(messages))
  if (!PROVIDERS_KEEPING_THINKING.has(getAPIProvider())) {
    kept = stripThinkingBlocks(kept as NormalizedMessage[])
  }
  return filterWhitespaceOnlyAssistantMessages(kept)
}

export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  try {
    const kept = keepWhatTheApiAccepts(serializedMessages.map(upgradeLegacyShapes))
    const interruption = detectTurnInterruption(kept as NormalizedMessage[])
    if (interruption.kind !== 'interrupted_turn') {
      return { messages: withAnswerPlaceholder(kept), turnInterruptionState: interruption }
    }
    const continuation = continuationPrompt()
    return {
      messages: withAnswerPlaceholder([...kept, continuation]),
      turnInterruptionState: { kind: 'interrupted_prompt', message: continuation },
    }
  } catch (error) {
    logError(error)
    throw error
  }
}

type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

/** The one line resume writes for the model, when a turn stopped between a tool result and its answer. */
const CONTINUATION_TEXT =
  'The previous session ended before this turn was finished. Continue the task from where it stopped.'

function continuationPrompt(): NormalizedUserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: CONTINUATION_TEXT }],
    isMeta: true,
  }) as NormalizedUserMessage
}

function detectTurnInterruption(
  messages: NormalizedMessage[],
): InternalInterruptionState {
  const deciding = messages.findLast(decidesTheTurn)
  if (!deciding || deciding.type === 'assistant') return { kind: 'none' }
  if (deciding.type !== 'user') return { kind: 'interrupted_turn' }
  if (isToolUseResultMessage(deciding)) return { kind: 'interrupted_turn' }
  if (deciding.isMeta || deciding.isCompactSummary) return { kind: 'none' }
  return { kind: 'interrupted_prompt', message: deciding }
}

/** Notices, progress, hook output and API errors say nothing about whether the turn finished. */
function decidesTheTurn(message: NormalizedMessage): boolean {
  if (message.type === 'system' || message.type === 'progress') return false
  if (message.type === 'assistant') return message.isApiErrorMessage !== true
  return !isHookOutput(message)
}

function isHookOutput(m: NormalizedMessage): boolean {
  return (
    m.type === 'attachment' &&
    (m.attachment.type.startsWith('hook_') ||
      m.attachment.type === 'async_hook_response')
  )
}

/** A list ending on a user message gets an answer right after it, so the list stays API-valid. */
function withAnswerPlaceholder(messages: Message[]): Message[] {
  const last = messages.findLastIndex(message => message.type !== 'system' && message.type !== 'progress')
  if (last === -1 || messages[last]!.type !== 'user') return messages
  const placeholder = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })
  return [...messages.slice(0, last + 1), placeholder, ...messages.slice(last + 1)]
}

// --- restoring: state the transcript already carries -----------------------------

export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment' || !message.attachment) continue
    const { attachment } = message
    switch (attachment.type) {
      case 'invoked_skills':
        for (const { name, path, content } of attachment.skills) {
          if (name && path && content) addInvokedSkill(name, path, content, null)
        }
        break
      case 'skill_listing':
        suppressNextSkillListing()
        break
      case 'bash_git_instructions':
        suppressNextBashGitInstructions()
        break
    }
  }
}

// --- the loader ----------------------------------------------------------------------

/** Timestamps at or before the epoch never pick a path resume's tip. */
const EPOCH_MS = 0

export async function loadMessagesFromJsonlPath(path: string): Promise<{
  messages: SerializedMessage[]
  sessionId: UUID | undefined
  costState: CostStateEntry | undefined
}> {
  const { messages, leafUuids, costStates } = await loadTranscriptFile(path)
  const tip = latestByTimestamp(
    messages.values(),
    entry => leafUuids.has(entry.uuid) && !entry.isSidechain,
    EPOCH_MS,
  )
  if (!tip) return { messages: [], sessionId: undefined, costState: undefined }
  // A fork copies its first entries from the source session; the tip names the session.
  const sessionId = tip.sessionId as UUID | undefined
  return {
    messages: removeExtraFields(buildConversationChain(messages, tip)),
    sessionId,
    costState: sessionId === undefined ? undefined : costStates.get(sessionId),
  }
}

type ResumeSource =
  | { kind: 'continue' }
  | { kind: 'sessionId'; sessionId: UUID }
  | { kind: 'log'; log: LogOption }
  | { kind: 'file'; path: string }

function resumeSourceOf(source: string | LogOption | undefined, sourceJsonlFile: string | undefined): ResumeSource {
  // No source is a --continue, whatever path came with it.
  if (source === undefined) return { kind: 'continue' }
  if (sourceJsonlFile) return { kind: 'file', path: sourceJsonlFile }
  if (typeof source === 'string') return { kind: 'sessionId', sessionId: source as UUID }
  return { kind: 'log', log: source }
}

/** A conversation found for a source, before it is readied. `log` is absent for a path. */
type FoundConversation = {
  messages: Message[]
  sessionId: UUID | undefined
  costState: CostStateEntry | undefined
  log?: LogOption
}

type LoadedResume = NonNullable<Awaited<ReturnType<typeof loadConversationForResume>>>

async function inFull(log: LogOption): Promise<LogOption> {
  return isLiteLog(log) ? loadFullLog(log) : log
}

async function findLog(
  source: Exclude<ResumeSource, { kind: 'file' }>,
): Promise<{ log: LogOption; sessionId: UUID | undefined } | null> {
  switch (source.kind) {
    case 'continue': {
      const [latest] = await loadMessageLogs()
      if (!latest) return null
      const log = await inFull(latest)
      return { log, sessionId: getSessionIdFromLog(log) }
    }
    case 'sessionId': {
      const log = await getLastSessionLog(source.sessionId)
      return log ? { log, sessionId: source.sessionId } : null
    }
    case 'log': {
      const log = await inFull(source.log)
      return { log, sessionId: getSessionIdFromLog(log) }
    }
  }
}

async function findConversation(source: ResumeSource): Promise<FoundConversation | null> {
  if (source.kind === 'file') return loadMessagesFromJsonlPath(source.path)
  const found = await findLog(source)
  if (!found) return null
  const { log, sessionId } = found
  await copyPlanForResume(log, sessionId === undefined ? undefined : asSessionId(sessionId))
  void copyFileHistoryForResume(log).catch(logError)
  return { messages: log.messages, sessionId, costState: log.costState, log }
}

type CarriedMetadata = Omit<LoadedResume, 'messages' | 'turnInterruptionState' | 'sessionId' | 'costState'>

function metadataOf(log: LogOption | undefined): CarriedMetadata {
  if (!log) return {}
  return {
    fileHistorySnapshots: log.fileHistorySnapshots,
    attributionSnapshots: log.attributionSnapshots,
    contextCollapseCommits: log.contextCollapseCommits,
    contextCollapseSnapshot: log.contextCollapseSnapshot,
    agentName: log.agentName,
    agentColor: log.agentColor,
    agentSetting: log.agentSetting,
    customTitle: log.customTitle,
    tag: log.tag,
    mode: log.mode,
    worktreeSession: log.worktreeSession,
    prNumber: log.prNumber,
    prUrl: log.prUrl,
    prRepository: log.prRepository,
    fullPath: log.fullPath,
  }
}

export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  // Session metadata for restoring agent context
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  // The session's running cost (last-wins). Required, so a loader branch
  // that forgets to carry it fails to compile instead of restoring $0.
  costState: CostStateEntry | undefined
  // Full path to the session file (for cross-directory resume)
  fullPath?: string
} | null> {
  try {
    const found = await findConversation(resumeSourceOf(source, sourceJsonlFile))
    if (!found) return null
    restoreSkillStateFromMessages(found.messages)
    const { messages, turnInterruptionState } = deserializeMessagesWithInterruptDetection(found.messages)
    // Checked before the hooks too, so an oversized session never runs them.
    assertResumeMessageSize(messages)
    const hookOutput = await processSessionStartHooks('resume', { sessionId: found.sessionId })
    const withHookOutput = [...messages, ...hookOutput]
    assertResumeMessageSize(withHookOutput)
    return {
      ...metadataOf(found.log),
      messages: withHookOutput,
      turnInterruptionState,
      sessionId: found.sessionId,
      costState: found.costState,
    }
  } catch (error) {
    logError(error)
    throw error
  }
}
