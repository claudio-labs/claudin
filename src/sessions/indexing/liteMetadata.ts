/**
 * The session index: which transcripts a project has, how each one shows in
 * a list, and what one holds in full.
 *
 * Listing is two passes. `getSessionFilesLite` lists from file stats alone;
 * `enrichLogs` then reads at most the first and last 64 KiB of each file.
 * A full load (`loadFullLog`, `getLastSessionLog`, ...) reads the whole
 * transcript and rebuilds the conversation along its `parentUuid` chain.
 *
 * The rules live beside this file: `listing/` (file stats), `liteRead/` (the
 * listed fields of a head and tail) and `fullLoad/` (the anchor rule and the
 * per-session entries of a loaded transcript).
 */

import type { UUID } from 'crypto'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from 'src/platform/bootstrap/state.js'
import type { AttributionSnapshotMessage } from 'src/shared/types/logs.js'
import {
  type LogOption,
  sortLogs,
  type TranscriptMessage,
} from 'src/shared/types/logs.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { extractFirstPrompt } from 'src/sessions/pure/firstPrompt.js'
import { removeExtraFields } from 'src/sessions/pure/logging.js'
import { getProjectDir, getTranscriptPath } from 'src/sessions/pure/paths.js'
import { buildConversationChain } from 'src/sessions/resume/chain.js'
import { getSessionMessages } from 'src/sessions/resume/cache.js'
import { loadTranscriptFile } from 'src/sessions/resume/transcriptLoad.js'
import { LITE_READ_BUF_SIZE, readHeadAndTail } from 'src/sessions/sessionStoragePortable.js'
import {
  listSessionFiles,
  newestFilesFirst,
  type SessionFileStat,
  statOnlyRecord,
} from 'src/sessions/indexing/listing/sessionFiles.js'
import { readListedFields } from 'src/sessions/indexing/liteRead/listedFields.js'
import { stringMemberPrefix } from 'src/sessions/indexing/liteRead/promptPrefix.js'
import { isBranchEndIn, isMainThreadMessage, newestMessage } from 'src/sessions/indexing/fullLoad/anchor.js'
import { readExportedMessages } from 'src/sessions/indexing/fullLoad/exportFile.js'
import {
  answersTool,
  callsTool,
  contentBlocks,
  contentOf,
  isMetaMessage,
} from 'src/sessions/indexing/fullLoad/messageContent.js'
import {
  collapseStateOf,
  type LoadedTranscript,
  sessionLabels,
  snapshotsOf,
  summaryOf,
  worktreeOf,
} from 'src/sessions/indexing/fullLoad/sessionEntries.js'

const DEFAULT_NODE_ENV = 'development'
const TRANSCRIPT_EXTENSION = '.jsonl'
/** User blocks a person sees as a turn, even when empty: what they typed or attached. */
const VISIBLE_USER_BLOCKS: ReadonlySet<unknown> = new Set(['text', 'image', 'document'])

// exported for testing
export function getNodeEnv(): string {
  return process.env.NODE_ENV || DEFAULT_NODE_ENV
}

export function isCustomTitleEnabled(): boolean {
  return true
}

export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (!filePath.endsWith(TRANSCRIPT_EXTENSION)) {
    const messages = await readExportedMessages(filePath)
    return convertToLogOption(messages, 0, undefined, undefined, undefined, undefined, filePath)
  }
  const loaded = await loadTranscriptFile(filePath)
  if (loaded.messages.size === 0) throw new Error('No messages found in JSONL file')
  const leaf = newestMessage(loaded.messages.values(), isBranchEndIn(loaded.leafUuids))
  if (!leaf) throw new Error('No valid conversation chain found in JSONL file')
  const chain = buildConversationChain(loaded.messages, leaf)
  const { customTitle, tag } = sessionLabels(loaded, leaf.sessionId)
  return {
    ...convertToLogOption(chain, 0, summaryOf(loaded, leaf.uuid), customTitle, undefined, tag, filePath),
    worktreeSession: worktreeOf(loaded, leaf.sessionId, undefined),
    ...collapseStateOf(loaded, leaf.sessionId),
  }
}

function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user' || isMetaMessage(message)) return false
  const content = contentOf(message)
  if (typeof content === 'string') return content.trim() !== ''
  return contentBlocks(message).some(block => VISIBLE_USER_BLOCKS.has(block.type))
}

function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false
  return contentBlocks(message).some(
    block => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '',
  )
}

function countVisibleMessages(transcript: TranscriptMessage[]): number {
  return transcript.filter(message => hasVisibleUserContent(message) || hasVisibleAssistantContent(message)).length
}

/** A record from messages, root first: dates and identity from the ends, title and turns from all. */
function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
): LogOption {
  const root = transcript[0]
  const end = transcript.at(-1)
  if (!root || !end) throw new Error('Cannot build session metadata from an empty transcript')
  return {
    date: end.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created: new Date(root.timestamp),
    modified: new Date(end.timestamp),
    firstPrompt: extractFirstPrompt(transcript),
    messageCount: countVisibleMessages(transcript),
    isSidechain: root.isSidechain ?? false,
    teamName: root.teamName,
    agentName: root.agentName,
    agentSetting,
    leafUuid: end.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots,
    attributionSnapshots,
    gitBranch: end.gitBranch,
    projectPath: root.cwd,
  }
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const cwd = getOriginalCwd()
  return getSessionFilesLite(getProjectDir(cwd), limit, cwd)
}

export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  const id = log.sessionId || log.messages[0]?.sessionId
  return id ? (id as UUID) : undefined
}

export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && Boolean(log.sessionId)
}

/** Fill a listed record in from its file, anchored on the newest branch end; `log` itself when there is none. */
async function completeFromFile(log: LogOption, fullPath: string): Promise<LogOption> {
  const loaded = await loadTranscriptFile(fullPath)
  const anchor = newestMessage(loaded.messages.values(), isBranchEndIn(loaded.leafUuids))
  if (!anchor) return log
  const chain = buildConversationChain(loaded.messages, anchor)
  const root = chain[0] ?? anchor
  const session = anchor.sessionId
  return {
    ...log,
    messages: removeExtraFields(chain),
    firstPrompt: extractFirstPrompt(chain),
    messageCount: countVisibleMessages(chain),
    summary: summaryOf(loaded, anchor.uuid),
    // A user title only: an AI title kept here would be written back as one (finding 5).
    ...sessionLabels(loaded, session),
    costState: loaded.costStates.get(session as UUID),
    worktreeSession: worktreeOf(loaded, session, log.worktreeSession),
    gitBranch: anchor.gitBranch,
    leafUuid: anchor.uuid,
    isSidechain: root.isSidechain,
    teamName: root.teamName,
    ...snapshotsOf(loaded, chain),
    ...collapseStateOf(loaded, session),
  }
}

export async function loadFullLog(log: LogOption): Promise<LogOption> {
  if (!isLiteLog(log) || !log.fullPath) return log
  try {
    return await completeFromFile(log, log.fullPath)
  } catch (error) {
    // The record stays usable as listed; a picker must not fail on one file.
    logForDebugging(`Could not load ${log.fullPath} in full: ${String(error)}`)
    return log
  }
}

/** Seed the persisted-uuid cache from a read just done, unless the session already has an entry. */
function rememberPersistedMessages(sessionId: UUID, uuids: Iterable<UUID>): void {
  const cache = getSessionMessages.cache
  if (!cache.has(sessionId)) cache.set(sessionId, Promise.resolve(new Set(uuids)))
}

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  // The path read is the path reported (finding 4).
  const fullPath = join(getSessionProjectDir() ?? getProjectDir(getOriginalCwd()), `${sessionId}${TRANSCRIPT_EXTENSION}`)
  const loaded = await loadTranscriptFile(fullPath)
  const anchor = newestMessage(loaded.messages.values(), isMainThreadMessage)
  if (!anchor) return null
  rememberPersistedMessages(sessionId, loaded.messages.keys())
  const chain = buildConversationChain(loaded.messages, anchor)
  const { customTitle, tag } = sessionLabels(loaded, anchor.sessionId)
  const { fileHistorySnapshots, attributionSnapshots } = snapshotsOf(loaded, chain)
  const summary = summaryOf(loaded, anchor.uuid)
  return {
    ...convertToLogOption(chain, 0, summary, customTitle, fileHistorySnapshots, tag, fullPath, attributionSnapshots, loaded.agentSettings.get(sessionId)),
    worktreeSession: worktreeOf(loaded, sessionId, undefined),
    costState: loaded.costStates.get(sessionId),
    ...collapseStateOf(loaded, sessionId),
  }
}

export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const listed = await fetchLogs(limit)
  const { logs } = await enrichLogs(listed, 0, listed.length)
  return sortLogs([...logs]).map((log, value) => ({ ...log, value }))
}

export async function getLogByIndex(index: number): Promise<LogOption | null> {
  return (await loadMessageLogs())[index] ?? null
}

export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  const { messages } = await loadTranscriptFile(getTranscriptPath())
  let caller: AssistantMessage | null = null
  for (const message of messages.values()) {
    if (message.type === 'user' && answersTool(message, toolUseId)) return null
    if (message.type === 'assistant' && callsTool(message, toolUseId)) caller = message
  }
  return caller
}

export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  return listSessionFiles(projectDir)
}

export const INITIAL_ENRICH_COUNT = 50

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  contextTokens?: number
  costUSD?: number
}

/** Messages that hang off a branch end without being one (closing notes, attachments), oldest first. */
function messagesAfterEnd(loaded: LoadedTranscript, end: TranscriptMessage): TranscriptMessage[] {
  return [...loaded.messages.values()]
    .filter(message => message.parentUuid === end.uuid && !loaded.leafUuids.has(message.uuid))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
}

function branchRecord(
  loaded: LoadedTranscript,
  end: TranscriptMessage,
  sessionFile: string,
  projectPathOverride: string | undefined,
): LogOption {
  const messages = [...buildConversationChain(loaded.messages, end), ...messagesAfterEnd(loaded, end)]
  const labels = sessionLabels(loaded, end.sessionId)
  const { fileHistorySnapshots, attributionSnapshots } = snapshotsOf(loaded, messages)
  const summary = summaryOf(loaded, end.uuid)
  const record = convertToLogOption(messages, 0, summary, labels.customTitle, fileHistorySnapshots, labels.tag, sessionFile, attributionSnapshots, labels.agentSetting)
  return {
    ...record,
    ...labels,
    date: end.timestamp,
    modified: new Date(end.timestamp),
    gitBranch: end.gitBranch,
    leafUuid: end.uuid,
    sessionId: end.sessionId,
    projectPath: projectPathOverride ?? record.projectPath,
  }
}

export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const loaded = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })
  return [...loaded.messages.values()]
    .filter(isBranchEndIn(loaded.leafUuids))
    .map(end => branchRecord(loaded, end, sessionFile, projectPathOverride))
}

export async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<LogOption[]> {
  const files: SessionFileStat[] = newestFilesFirst((await getSessionFilesWithMtime(projectDir)).values())
  const read = limit && limit < files.length ? files.slice(0, limit) : files
  const logs: LogOption[] = []
  // One file at a time: each is loaded whole, so reading them together would hold them all at once.
  for (const file of read) logs.push(...(await loadAllLogsFromSessionFile(file.path)))
  return logs
}

async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  return readListedFields(
    { head, tail, tailStartsMidLine: fileSize > LITE_READ_BUF_SIZE },
    { stringPrefix: extractJsonStringFieldPrefix },
  )
}

function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string {
  return stringMemberPrefix(text, key, maxLen)
}

export function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const newest = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) continue
    const kept = newest.get(log.sessionId)
    if (!kept || log.modified.getTime() > kept.modified.getTime()) newest.set(log.sessionId, log)
  }
  return sortLogs([...newest.values()]).map((log, value) => ({ ...log, value }))
}

export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const files = await getSessionFilesWithMtime(projectDir)
  const records = sortLogs([...files].map(([sessionId, file]) => statOnlyRecord(sessionId, file, projectPath)))
  const kept = limit && limit < records.length ? records.slice(0, limit) : records
  return kept.map((log, value) => ({ ...log, value }))
}

/** The listed record with what its head and tail say, or null for a session the list hides; without a file, `log` itself. */
async function enrichLog(
  log: LogOption,
  readBuf: Buffer,
): Promise<LogOption | null> {
  if (!log.fullPath) return log
  const fields = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)
  if (fields.isSidechain || fields.teamName) return null
  return { ...log, ...fields, projectPath: fields.projectPath ?? log.projectPath, isLite: false }
}

export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  // One buffer for every file: a listing reads at most two windows per file through it.
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  const logs: LogOption[] = []
  let index = startIndex
  while (index < allLogs.length && logs.length < count) {
    const log = allLogs[index++]!
    const shown = log.isLite ? await enrichLog(log, readBuf) : log
    if (shown) logs.push(shown)
  }
  return { logs, nextIndex: index }
}
