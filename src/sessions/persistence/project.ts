/**
 * Project singleton + lifecycle for the local on-disk transcript.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split. The class itself
 * (write queue, pending entries, flush timer, sessionMetadata cache,
 * materializeSessionFile, persistToRemote) was decision "opção a" of the
 * plan — single file, no further splitting. The 3 test helpers
 * (resetProjectFlushStateForTesting, resetProjectForTesting,
 * setSessionFileForTesting) live here so they manipulate the same
 * module-level singleton (`let project`) — moving them anywhere else
 * silently breaks the singleton invariant.
 *
 * Includes `hydrateRemoteSession`, `hydrateFromCCRv2InternalEvents`,
 * `setInternalEventWriter`, `setInternalEventReader`,
 * `setRemoteIngressUrlForTesting` — all Project-coupled remote ingress
 * surfaces that share state with the singleton. Per plan gap #2 these
 * stay together rather than going to indexing/agents.ts.
 *
 * NOT exported from the public barrel directly: the barrel
 * (src/sessions/sessionStorage.ts) re-exports a public subset.
 *
 * The pure pieces live in `./writer/`: line formatting, the recording plan,
 * the metadata block, the remover, the persistence gate and the private-file
 * helper.
 */
import type { UUID } from 'crypto'
import {
  appendFile as fsAppendFile,
  mkdir,
  open as fsOpen,
  readFile,
  stat,
  writeFile,
} from 'fs/promises'
import { dirname, join } from 'path'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  isSessionPersistenceDisabled,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import * as sessionIngress from 'src/providers/transport/sessionIngress.js'
import { asAgentId, asSessionId } from 'src/shared/types/ids.js'
import type { AttributionSnapshotMessage } from 'src/shared/types/logs.js'
import {
  type Entry,
  type FileHistorySnapshotMessage,
  type PersistedWorktreeSession,
  type TranscriptMessage,
} from 'src/shared/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/shared/types/message.js'
import type { QueueOperationMessage } from 'src/shared/types/messageQueueTypes.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logForDebugging } from 'src/shared/debug.js'
import { logForDiagnosticsNoPII } from 'src/shared/diagLogs.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { getBranch } from 'src/vcs/git/git.js'
import {
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/shared/proc/gracefulShutdown.js'
import { logError } from 'src/shared/log.js'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import {
  getFirstMeaningfulUserMessageTextContent,
} from 'src/sessions/pure/firstPrompt.js'
import {
  getUserType,
} from 'src/sessions/pure/logging.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from 'src/sessions/pure/paths.js'
import {
  isChainParticipant,
  isTranscriptMessage,
} from 'src/sessions/pure/typeGuards.js'
import { getSessionMessages } from 'src/sessions/resume/cache.js'
import {
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
} from 'src/sessions/sessionStoragePortable.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'
import { getCostStateEntryFor } from 'src/agent/cost-tracker.js'
import {
  appendEntryToFile,
  readFileTailSync,
} from 'src/sessions/persistence/_helpers.js'
import {
  isPersistenceDisabledByUser,
  isPersistenceOff,
} from 'src/sessions/persistence/writer/gate.js'
import { agentFileOf, toTranscriptLines } from 'src/sessions/persistence/writer/lines.js'
import {
  metadataBlock,
  readExternalWrites,
  type MetadataSnapshot,
} from 'src/sessions/persistence/writer/metadataBlock.js'
import {
  appendPrivate,
  appendPrivateSync,
  replacePrivate,
  toJsonl,
} from 'src/sessions/persistence/writer/privateFiles.js'
import {
  groupByAgent,
  internalEventOptions,
  isEpochMismatch,
} from 'src/sessions/persistence/writer/remote.js'
import {
  APPEND_CHUNK_LIMIT_BYTES,
  QueueState,
} from 'src/sessions/persistence/writer/queueState.js'
import { removeMessageLine } from 'src/sessions/persistence/writer/remover.js'

// Cache MACRO.VERSION at module level to work around bun --define bug in
// async contexts. See: https://github.com/oven-sh/bun/issues/26168
// IMPORTANT: keep the `typeof MACRO !== 'undefined'` guard literal — the
// build preprocessor only substitutes when the literal compares against
// 'undefined'.
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

const REMOTE_FLUSH_INTERVAL_MS = 10

type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

function getNodeEnv(): string {
  return process.env.NODE_ENV ?? ''
}

function getEntrypoint(): string | undefined {
  return process.env.CLAUDE_CODE_ENTRYPOINT
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

let project: Project | null = null
let cleanupRegistered = false

export function getProject(): Project {
  if (project) return project
  project = new Project()
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(settleAtExit)
  }
  return project
}

/** Exit: the queue first, then the stamps that must end the file. */
async function settleAtExit(): Promise<void> {
  const current = project
  if (!current) return
  try {
    await current.flush()
  } catch (error) {
    logError(error)
  }
  try {
    current.reAppendSessionMetadata()
  } catch {
    // Best-effort: the transcript is already complete without it.
  }
  try {
    current.reAppendCostState()
  } catch (error) {
    logError(error)
  }
}

export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

export function resetProjectForTesting(): void {
  project?._resetFlushState()
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  const current = getProject()
  current.setInternalEventReader(reader)
  current.setInternalSubagentEventReader(subagentReader)
}

export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

/** Only user and assistant messages bring the transcript file into being. */
function opensTranscript(entry: Entry): boolean {
  return entry.type === 'user' || entry.type === 'assistant'
}

function hasUuid(entry: Entry, uuid: UUID): boolean {
  return 'uuid' in entry && entry.uuid === uuid
}

export class Project {
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  /** The open transcript's path, or null until the session's first message opens it. */
  sessionFile: string | null = null
  /** Entries recorded before the transcript opened, written when it does. */
  private heldEntries: Entry[] = []
  private readonly queue = new QueueState()
  private ingressUrl: string | null = null
  private eventWriter: InternalEventWriter | null = null
  private eventReader: InternalEventReader | null = null
  private subagentEventReader: InternalEventReader | null = null

  /** Settles once every recording call handed in so far has queued its lines. */
  private recordingTail: Promise<unknown> = Promise.resolve()

  constructor() {}

  _resetFlushState(): void {
    if (this.queue.timer) clearTimeout(this.queue.timer)
    this.queue.timer = null
    this.queue.drainChain = null
    for (const lines of this.queue.linesByFile.values()) {
      for (const item of lines) item.resolve()
    }
    this.queue.linesByFile.clear()
    this.queue.inFlight = 0
    this.releaseFlushWaiters()
  }

  private releaseFlushWaiters(): void {
    for (const release of this.queue.idleWaiters.splice(0)) release()
  }

  private incrementPendingWrites(): void {
    this.queue.inFlight += 1
  }

  private decrementPendingWrites(): void {
    this.queue.inFlight = Math.max(0, this.queue.inFlight - 1)
    if (this.queue.inFlight === 0) this.releaseFlushWaiters()
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  /**
   * Runs recording calls one after another, so a call sees what the one
   * before it recorded, and a removal can wait for lines still on their way
   * to the queue.
   */
  runInOrder<T>(task: () => Promise<T>): Promise<T> {
    const run = this.recordingTail.then(task)
    this.recordingTail = run.catch(() => undefined)
    return run
  }

  /** Resolves once the entry's batch was attempted; a failed batch is reported by the drain. */
  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    return new Promise(resolve => {
      const lines = this.queue.linesByFile.get(filePath)
      if (lines) lines.push({ entry, resolve })
      else this.queue.linesByFile.set(filePath, [{ entry, resolve }])
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.queue.timer) return
    this.queue.timer = setTimeout(() => {
      this.queue.timer = null
      // Nobody awaits the timer, so its failure is logged rather than left
      // as an unhandled rejection (finding 6).
      this.drainQueuedWrites().catch(logError)
    }, this.queue.delayMs)
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    await appendPrivate(filePath, data)
  }

  /** Text chunks of the queued entries, none over APPEND_CHUNK_LIMIT_BYTES unless one line is. */
  private chunksOf(entries: readonly Entry[]): string[] {
    const chunks: string[] = []
    let chunk = ''
    let bytes = 0
    for (const entry of entries) {
      const line = toJsonl([entry])
      const size = Buffer.byteLength(line)
      if (bytes > 0 && bytes + size > APPEND_CHUNK_LIMIT_BYTES) {
        chunks.push(chunk)
        chunk = ''
        bytes = 0
      }
      chunk += line
      bytes += size
    }
    if (chunk) chunks.push(chunk)
    return chunks
  }

  /** Writes what is queued now, file by file; a file whose append fails loses that batch. */
  private async drainWriteQueue(): Promise<void> {
    const batches = [...this.queue.linesByFile]
    this.queue.linesByFile.clear()
    let failure: { error: unknown } | undefined
    for (const [filePath, items] of batches) {
      try {
        for (const chunk of this.chunksOf(items.map(item => item.entry))) {
          await this.appendToFile(filePath, chunk)
        }
      } catch (error) {
        failure ??= { error }
      } finally {
        for (const item of items) item.resolve()
      }
    }
    if (failure) throw failure.error
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.heldEntries = []
  }

  /** Whether an entry with this uuid waits for the transcript file to open. */
  holdsEntry(uuid: UUID): boolean {
    return this.heldEntries.some(entry => hasUuid(entry, uuid))
  }

  reAppendSessionMetadata(skipTitleRefresh = false): void {
    const file = this.sessionFile
    const sessionId = getSessionId() as UUID
    if (!file || !sessionId || isPersistenceDisabledByUser()) return
    this.absorbExternalWrites(file, skipTitleRefresh)
    const lines = metadataBlock(this.metadataSnapshot(), sessionId, new Date())
    if (lines.length > 0) appendPrivateSync(file, toJsonl(lines))
  }

  /** Another process (the SDK, say) may have renamed or tagged the session: its word wins. */
  private absorbExternalWrites(file: string, skipTitle: boolean): void {
    const external = readExternalWrites(readFileTailSync(file))
    if (!skipTitle && external.title !== undefined) this.currentSessionTitle = external.title || undefined
    if (external.tag !== undefined) this.currentSessionTag = external.tag || undefined
  }

  private metadataSnapshot(): MetadataSnapshot {
    return {
      lastPrompt: this.currentSessionLastPrompt,
      title: this.currentSessionTitle,
      tag: this.currentSessionTag,
      agentName: this.currentSessionAgentName,
      agentColor: this.currentSessionAgentColor,
      agentSetting: this.currentSessionAgentSetting,
      mode: this.currentSessionMode,
      worktree: this.currentSessionWorktree,
      prNumber: this.currentSessionPrNumber,
      prUrl: this.currentSessionPrUrl,
      prRepository: this.currentSessionPrRepository,
    }
  }

  /**
   * Stamp the session's running cost at EOF — Claude Code's exit re-stamp of
   * its `cost-state` entry, which --resume and -c restore (last one wins).
   * Called by the exit cleanup below and by saveCurrentSessionCosts (/clear
   * and /resume before they switch away, the REPL's process 'exit'), hence
   * sync. Unlike reAppendSessionMetadata it does not run at materialize or
   * compaction: a stamp taken there would outrank the message replay of a
   * session that then crashed before its exit.
   */
  reAppendCostState(): void {
    if (!this.sessionFile || this.shouldSkipPersistence()) return
    const entry = getCostStateEntryFor(getSessionId())
    if (entry) appendEntryToFile(this.sessionFile, entry)
  }

  async flush(): Promise<void> {
    if (this.queue.timer) {
      clearTimeout(this.queue.timer)
      this.queue.timer = null
    }
    await this.drainQueuedWrites()
    if (this.queue.inFlight > 0) {
      await new Promise<void>(resolve => this.queue.idleWaiters.push(resolve))
    }
  }

  /**
   * Drain everything currently in the write queues to disk, bypassing the
   * flush timer. Unlike flush(), this does NOT wait for non-queue tracked
   * operations — which makes it safe to call from inside trackWrite
   * (flush() there would deadlock on its own in-flight count).
   */
  private async drainQueuedWrites(): Promise<void> {
    // Drains never overlap: two appends to one file must land in queue order.
    const previous = this.queue.drainChain ?? Promise.resolve()
    const run = previous.then(() => this.drainWriteQueue())
    this.queue.drainChain = run.catch(() => undefined)
    await run
  }

  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    const recorded = this.recordingTail
    await this.trackWrite(async () => {
      await recorded
      if (!this.sessionFile) {
        this.heldEntries = this.heldEntries.filter(entry => !hasUuid(entry, targetUuid))
        return
      }
      await this.drainQueuedWrites()
      await removeMessageLine(this.sessionFile, targetUuid, {
        tailBytes: LITE_READ_BUF_SIZE,
        maxRewriteBytes: MAX_TOMBSTONE_REWRITE_BYTES,
      })
    }).catch(error => {
      if (!isFsInaccessible(error)) logError(error)
    })
  }

  private shouldSkipPersistence(): boolean {
    return isPersistenceOff(getNodeEnv())
  }

  private async materializeSessionFile(): Promise<void> {
    if (this.sessionFile || this.shouldSkipPersistence()) return
    await this.openSessionFile(this.ensureCurrentSessionFile(), false)
  }

  /** Makes the current session's transcript the open file without a message, and stamps the metadata at once. */
  adoptSessionFile(): void {
    this.sessionFile = getTranscriptPath()
    this.openSessionFile(this.sessionFile, true).catch(logError)
  }

  private async openSessionFile(file: string, skipTitleRefresh: boolean): Promise<void> {
    try {
      this.reAppendSessionMetadata(skipTitleRefresh)
    } catch (error) {
      logError(error)
    }
    const held = this.heldEntries
    this.heldEntries = []
    for (const entry of held) void this.enqueueWrite(file, entry)
    for (const entry of held) await this.afterMainWrite(entry)
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
  ) {
    if (messages.length === 0 || this.shouldSkipPersistence()) return
    const cwd = getCwd()
    const gitBranch = await getBranch().catch(() => 'HEAD')
    const sessionId = getSessionId()
    const lines = toTranscriptLines(
      messages,
      {
        parent: startingParentUuid ?? null,
        isSidechain,
        agentId,
        teamName: teamInfo?.teamName,
        agentName: teamInfo?.agentName,
        promptId: getPromptId() ?? undefined,
      },
      {
        userType: getUserType(),
        entrypoint: getEntrypoint(),
        cwd,
        sessionId,
        version: VERSION,
        gitBranch,
        slug: getPlanSlugCache().get(sessionId),
      },
    )
    for (const line of lines) await this.appendEntry(line)
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    const entry: FileHistorySnapshotMessage = {
      type: 'file-history-snapshot',
      messageId,
      snapshot,
      isSnapshotUpdate,
    }
    await this.appendEntry(entry)
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    await this.appendEntry(queueOp)
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    await this.appendEntry(snapshot)
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) return
    if (sessionId !== getSessionId()) {
      const file = await this.getExistingSessionFile(sessionId)
      if (file) void this.enqueueWrite(file, entry)
      return
    }
    const agentId = isTranscriptMessage(entry) ? agentFileOf(entry) : undefined
    if (agentId !== undefined) {
      void this.enqueueWrite(getAgentTranscriptPath(asAgentId(agentId)), entry)
      return
    }
    if (!this.sessionFile) {
      if (!opensTranscript(entry)) {
        this.heldEntries.push(entry)
        return
      }
      await this.materializeSessionFile()
    }
    void this.enqueueWrite(this.ensureCurrentSessionFile(), entry)
    await this.afterMainWrite(entry, sessionId)
  }

  /** A main-file message counts as recorded once queued, and is mirrored remotely. */
  private async afterMainWrite(entry: Entry, sessionId: UUID = getSessionId() as UUID): Promise<void> {
    if (!isTranscriptMessage(entry)) return
    try {
      ;(await getSessionMessages(sessionId)).add(entry.uuid)
    } catch (error) {
      logForDebugging(`Could not note ${entry.uuid} as recorded: ${String(error)}`)
    }
    await this.persistToRemote(sessionId, entry)
  }

  private ensureCurrentSessionFile(): string {
    this.sessionFile ??= getTranscriptPath()
    return this.sessionFile
  }

  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    const known = this.existingSessionFiles.get(sessionId)
    if (known) return known
    const file = getTranscriptPathForSession(sessionId)
    try {
      await stat(file)
    } catch {
      return null
    }
    this.existingSessionFiles.set(sessionId, file)
    return file
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    const writer = this.eventWriter
    if (writer) {
      try {
        await writer('transcript', entry as unknown as Record<string, unknown>, internalEventOptions(entry))
      } catch (error) {
        logForDebugging(`Internal event writer failed for ${entry.uuid}: ${String(error)}`, { level: 'warn' })
      }
      return
    }
    const url = this.ingressUrl
    if (!url || !isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE) || isShuttingDown()) return
    const accepted = await sessionIngress.appendSessionLog(sessionId, entry, url).catch(() => false)
    if (accepted) return
    // The remote copy is the durable one; going on would lose turns silently (finding 5).
    logForDiagnosticsNoPII('error', 'session_persist_fail_remote_exit')
    gracefulShutdownSync(1)
  }

  setRemoteIngressUrl(url: string): void {
    this.ingressUrl = url
    this.queue.delayMs = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.eventWriter = writer
    this.queue.delayMs = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.eventReader = reader
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.subagentEventReader = reader
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.eventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.subagentEventReader
  }
}

/** Where a hydrated session lands: the original cwd's project directory. */
function hydratedTranscriptPath(sessionId: string): string {
  return join(getProjectDir(getOriginalCwd()), `${sessionId}.jsonl`)
}

/** Replaces the session's transcript with `payloads` and forgets what was remembered of it. */
async function writeHydrated(sessionId: string, payloads: readonly object[]): Promise<void> {
  await replacePrivate(hydratedTranscriptPath(sessionId), toJsonl(payloads))
  getSessionMessages.cache.delete?.(sessionId)
}

export async function hydrateRemoteSession(
  sessionId: string,
  ingressUrl: string,
): Promise<boolean> {
  switchSession(asSessionId(sessionId))
  try {
    // A refused or failed read counts as an empty session: in CCR the server
    // is authoritative, and a stale local copy would fight every PUT (finding 4).
    const logs = (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) ?? []
    await writeHydrated(sessionId, logs)
    return logs.length > 0
  } catch (error) {
    logError(error)
    return false
  } finally {
    getProject().setRemoteIngressUrl(ingressUrl)
  }
}

export async function hydrateFromCCRv2InternalEvents(
  sessionId: string,
): Promise<boolean> {
  switchSession(asSessionId(sessionId))
  const current = getProject()
  const reader = current.getInternalEventReader()
  if (!reader) return false
  try {
    const events = await reader()
    if (!events) return false
    await writeHydrated(sessionId, events.map(event => event.payload))
    const subagentReader = current.getInternalSubagentEventReader()
    const subagentEvents = subagentReader ? await subagentReader() : null
    for (const [agentId, payloads] of groupByAgent(subagentEvents ?? [])) {
      await replacePrivate(getAgentTranscriptPath(asAgentId(agentId)), toJsonl(payloads))
    }
    return events.length > 0
  } catch (error) {
    if (isEpochMismatch(error)) throw error
    logError(error)
    return false
  }
}
