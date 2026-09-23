import type {
  SerializedMessage,
  TranscriptMessage,
} from 'src/shared/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/shared/types/message.js'
import { shouldPersistAttachment } from 'src/sessions/pure/attachmentPersistence.js'

type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

// exported for testing — kept as a stub returning 'external' for this open
// build. Preserved here (instead of in the barrel) so logging helpers in this
// module call it locally without a circular sessionStorage import.
export function getUserType(): string {
  return 'external'
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

// Exported so useLogMessages can sync-compute the last loggable uuid
// without awaiting recordTranscript's return value (race-free hint tracking).
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  // Upstream kept attachments out of external transcripts over training
  // exposure. Here a transcript only leaves the machine through a remote
  // session the user sets up, and a resumed session needs its attachments to
  // re-send the prefix it cached — see attachmentPersistence.ts.
  if (m.type === 'attachment') {
    return shouldPersistAttachment(m.attachment.type)
  }
  return true
}

/**
 * For external users, promote isVirtual messages to real ones in the persisted
 * transcript, so a --resume shows a coherent native-tool-call history instead
 * of messages a renderer would treat as synthetic. Ant transcripts keep the
 * flag.
 */
function transformMessagesForExternalTranscript(
  messages: Transcript,
): Transcript {
  return messages.flatMap(m => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      if (content.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      if (content.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content } }]
      }
      return [m]
    }
    // string-content user, system, attachment
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}

export function cleanMessagesForLogging(
  messages: Message[],
  _allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(filtered)
    : filtered
}
