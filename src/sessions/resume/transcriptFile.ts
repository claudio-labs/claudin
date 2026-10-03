/**
 * What one transcript file holds once its lines are sorted: the conversation
 * entries, keyed by uuid in file order, and the session metadata written
 * around them. The I/O (and the cut of large files) is transcriptLoad's; this
 * module only takes parsed lines.
 */
import type { UUID } from 'crypto'

import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  CostStateEntry,
  Entry,
  FileHistorySnapshotMessage,
  PersistedWorktreeSession,
  TranscriptMessage,
} from 'src/shared/types/logs.js'
import { isLegacyProgressEntry, isTranscriptMessage } from 'src/sessions/pure/typeGuards.js'

export type LoadedTranscript = {
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  costStates: Map<UUID, CostStateEntry>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}

export function emptyTranscript(): LoadedTranscript {
  return {
    messages: new Map(),
    summaries: new Map(),
    customTitles: new Map(),
    tags: new Map(),
    agentNames: new Map(),
    agentColors: new Map(),
    agentSettings: new Map(),
    prNumbers: new Map(),
    prUrls: new Map(),
    prRepositories: new Map(),
    modes: new Map(),
    worktreeStates: new Map(),
    costStates: new Map(),
    fileHistorySnapshots: new Map(),
    attributionSnapshots: new Map(),
    contextCollapseCommits: [],
    contextCollapseSnapshot: undefined,
    leafUuids: new Set(),
  }
}

type Line = Record<string, unknown> & { type: string }

type TranscriptCollectorDeps = {
  /** The validated cost line, or `undefined` when the line must be skipped. */
  parseCostState: (line: unknown) => CostStateEntry | undefined
}

type SessionMetadataWriter = (into: LoadedTranscript, line: Line, session: UUID, deps: TranscriptCollectorDeps) => void

/**
 * Metadata keyed by the line's session, later lines overwriting earlier ones.
 * Also the kinds a large transcript still reads from before its cut.
 */
const SESSION_METADATA: Readonly<Record<string, SessionMetadataWriter>> = {
  'custom-title': (into, line, session) => into.customTitles.set(session, line.customTitle as string),
  tag: (into, line, session) => into.tags.set(session, line.tag as string),
  'agent-name': (into, line, session) => into.agentNames.set(session, line.agentName as string),
  'agent-color': (into, line, session) => into.agentColors.set(session, line.agentColor as string),
  'agent-setting': (into, line, session) => into.agentSettings.set(session, line.agentSetting as string),
  mode: (into, line, session) => into.modes.set(session, line.mode as string),
  'worktree-state': (into, line, session) =>
    into.worktreeStates.set(session, line.worktreeSession as PersistedWorktreeSession | null),
  'pr-link': (into, line, session) => {
    into.prNumbers.set(session, line.prNumber as number)
    into.prUrls.set(session, line.prUrl as string)
    into.prRepositories.set(session, line.prRepository as string)
  },
  'cost-state': (into, line, session, deps) => {
    const cost = deps.parseCostState(line)
    if (cost) into.costStates.set(session, cost)
  },
}

function asLine(value: unknown): Line | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { type } = value as { type?: unknown }
  return typeof type === 'string' ? (value as Line) : undefined
}

/** Sorts parsed transcript lines into a `LoadedTranscript`, in the order they are given. */
export class TranscriptCollector {
  readonly transcript = emptyTranscript()
  // Legacy progress entry → the nearest non-progress ancestor (null at a root).
  private readonly progressStandIns = new Map<string, UUID | null>()

  constructor(private readonly deps: TranscriptCollectorDeps) {}

  /** A line written before a large file's cut: only its session metadata counts. */
  takeMetadata(value: unknown): void {
    const line = asLine(value)
    if (line) this.applyMetadata(line)
  }

  take(value: unknown): void {
    const line = asLine(value)
    if (!line) return
    if (isLegacyProgressEntry(line)) {
      this.progressStandIns.set(line.uuid, this.standInFor(line.parentUuid))
      return
    }
    const entry = line as unknown as Entry
    if (isTranscriptMessage(entry)) {
      this.addMessage(entry)
      return
    }
    if (this.applyMetadata(line)) return
    this.applyStateEntry(line)
  }

  private standInFor(parent: unknown): UUID | null {
    if (typeof parent !== 'string') return null
    const standIn = this.progressStandIns.get(parent)
    return standIn === undefined ? (parent as UUID) : standIn
  }

  private addMessage(entry: TranscriptMessage): void {
    const { transcript } = this
    const reparented =
      entry.parentUuid && this.progressStandIns.has(entry.parentUuid)
        ? { ...entry, parentUuid: this.standInFor(entry.parentUuid) }
        : entry
    transcript.messages.set(entry.uuid, reparented)
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      transcript.contextCollapseCommits = []
      transcript.contextCollapseSnapshot = undefined
    }
  }

  private applyMetadata(line: Line): boolean {
    if (line.type === 'summary') {
      if (typeof line.leafUuid === 'string') {
        this.transcript.summaries.set(line.leafUuid as UUID, line.summary as string)
      }
      return true
    }
    const write = Object.hasOwn(SESSION_METADATA, line.type) ? SESSION_METADATA[line.type] : undefined
    if (!write) return false
    if (typeof line.sessionId === 'string') write(this.transcript, line, line.sessionId as UUID, this.deps)
    return true
  }

  private applyStateEntry(line: Line): void {
    const { transcript } = this
    switch (line.type) {
      case 'file-history-snapshot':
        transcript.fileHistorySnapshots.set(line.messageId as UUID, line as unknown as FileHistorySnapshotMessage)
        return
      case 'attribution-snapshot':
        transcript.attributionSnapshots.set(line.messageId as UUID, line as unknown as AttributionSnapshotMessage)
        return
      case 'marble-origami-commit':
        transcript.contextCollapseCommits.push(line as unknown as ContextCollapseCommitEntry)
        return
      case 'marble-origami-snapshot':
        transcript.contextCollapseSnapshot = line as unknown as ContextCollapseSnapshotEntry
        return
    }
  }
}

/**
 * The entries that end a branch: for each entry no other entry names as its
 * parent, the nearest user or assistant entry at or above it.
 */
export function findTips(messages: Map<UUID, TranscriptMessage>): Set<UUID> {
  const parents = new Set<UUID>()
  for (const entry of messages.values()) {
    if (entry.parentUuid) parents.add(entry.parentUuid)
  }
  const tips = new Set<UUID>()
  for (const entry of messages.values()) {
    if (parents.has(entry.uuid)) continue
    const tip = nearestExchange(entry, messages)
    if (tip) tips.add(tip.uuid)
  }
  return tips
}

function nearestExchange(
  from: TranscriptMessage,
  messages: Map<UUID, TranscriptMessage>,
): TranscriptMessage | undefined {
  const passed = new Set<UUID>()
  let current: TranscriptMessage | undefined = from
  while (current && !passed.has(current.uuid)) {
    if (current.type === 'user' || current.type === 'assistant') return current
    passed.add(current.uuid)
    current = current.parentUuid ? messages.get(current.parentUuid) : undefined
  }
  return undefined
}
