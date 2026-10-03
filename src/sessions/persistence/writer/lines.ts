/**
 * Turns the messages of one call into transcript lines: the chain links, the
 * writer's flags, then the message itself, then the session stamp. Pure; the
 * caller reads the stamp's inputs at call time.
 */
import type { UUID } from 'crypto'
import { isCompactBoundaryMessage } from 'src/agent/messages/messages.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/shared/types/message.js'

/** The message kinds a transcript holds. */
export type ChainMessage = UserMessage | AssistantMessage | AttachmentMessage | SystemMessage

/** A stamped message as it is written: one JSON object per line. */
export type TranscriptLine = TranscriptMessage

/**
 * Members that always come from the writer. One left undefined removes what
 * the message carried, because JSON.stringify drops it.
 */
export type SessionStamp = {
  userType: string
  entrypoint: string | undefined
  cwd: string
  sessionId: string
  version: string
  gitBranch: string
  slug: string | undefined
}

export type ChainOptions = {
  /** What the first message of the call hangs off. */
  parent: UUID | null
  isSidechain: boolean
  agentId?: string
  teamName?: string
  agentName?: string
  /** Stamped on user lines only. */
  promptId?: string
}

/** The parent a message would get from position alone. */
function naturalParent(message: ChainMessage, previous: UUID | null): UUID | null {
  if (message.type === 'user' && message.sourceToolAssistantUUID) return message.sourceToolAssistantUUID
  return previous
}

function linkFields(message: ChainMessage, previous: UUID | null): Pick<TranscriptLine, 'parentUuid' | 'logicalParentUuid'> {
  const parent = naturalParent(message, previous)
  // A boundary opens a fresh chain; the logical parent keeps the way back.
  if (isCompactBoundaryMessage(message)) return { parentUuid: null, logicalParentUuid: parent ?? undefined }
  return { parentUuid: parent, logicalParentUuid: undefined }
}

export function toTranscriptLines(
  messages: readonly ChainMessage[],
  options: ChainOptions,
  stamp: SessionStamp,
): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  let previous = options.parent
  for (const message of messages) {
    const line = {
      ...linkFields(message, previous),
      isSidechain: options.isSidechain,
      teamName: options.teamName,
      agentName: options.agentName,
      promptId: message.type === 'user' ? options.promptId : undefined,
      agentId: options.agentId,
      ...message,
      ...stamp,
    }
    lines.push(line as TranscriptLine)
    previous = message.uuid
  }
  return lines
}

/** A line that belongs in an agent's own file rather than the main transcript. */
export function agentFileOf(line: TranscriptLine): string | undefined {
  return line.isSidechain && line.agentId !== undefined ? line.agentId : undefined
}

export type RecordingPlan<M> = {
  /** The messages not yet recorded, in call order. */
  fresh: M[]
  /** What the first fresh message hangs off. */
  parent: UUID | null
  /** The uuid the caller's next slice chains from. */
  last: UUID | null
}

/**
 * Splits a call into what still needs writing. Recorded messages ahead of the
 * first new one move the starting parent; those after it do not, so a compact
 * boundary followed by kept messages stays at the head of its chain.
 */
export function planRecording<M extends { uuid: UUID }>(
  messages: readonly M[],
  isRecorded: (uuid: UUID) => boolean,
  hint: UUID | null | undefined,
): RecordingPlan<M> {
  const fresh: M[] = []
  const seenInCall = new Set<UUID>()
  let parent = hint ?? null
  for (const message of messages) {
    const recorded = isRecorded(message.uuid) || seenInCall.has(message.uuid)
    seenInCall.add(message.uuid)
    if (!recorded) fresh.push(message)
    else if (fresh.length === 0) parent = message.uuid
  }
  return { fresh, parent, last: fresh.at(-1)?.uuid ?? parent }
}
