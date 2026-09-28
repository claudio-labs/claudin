import type { UUID } from 'crypto'
import type { Entry, TranscriptMessage } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'

// Only `type` decides what an on-disk entry is. Everything that is not one of
// these four kinds is session metadata (titles, tags, snapshots, ...) or a
// kind a newer build introduced.
const CONVERSATION_KINDS: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
])

export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return CONVERSATION_KINDS.has(entry.type)
}

/** Progress ticks are never linked into the parentUuid chain. */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

/** A progress line written by a build that still recorded progress. */
export type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

export function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const { type, uuid } = entry as { type?: unknown; uuid?: unknown }
  return type === 'progress' && typeof uuid === 'string'
}

/** Tool ticks of which only the latest is ever shown. */
export const EPHEMERAL_PROGRESS_TYPES: ReadonlySet<string> = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  'build_progress',
  'test_progress',
  'check_progress',
])

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}
