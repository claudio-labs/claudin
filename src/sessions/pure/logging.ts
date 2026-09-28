import { shouldPersistAttachment } from 'src/sessions/pure/attachmentPersistence.js'
import type { SerializedMessage, TranscriptMessage } from 'src/shared/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/shared/types/message.js'

type WrittenMessage = UserMessage | AssistantMessage | AttachmentMessage | SystemMessage

/** Transcripts are written for external users only; there is no other kind. */
export function getUserType(): string {
  return 'external'
}

/** The entries as a log listing carries them: without their chain links. */
export function removeExtraFields(transcript: TranscriptMessage[]): SerializedMessage[] {
  return transcript.map(({ parentUuid: _parentUuid, isSidechain: _isSidechain, ...entry }) => entry)
}

export function isLoggableMessage(m: Message): boolean {
  switch (m.type) {
    case 'progress':
      return false
    case 'attachment':
      return shouldPersistAttachment(m.attachment.type)
    default:
      return true
  }
}

function isWritten(m: Message): m is WrittenMessage {
  return isLoggableMessage(m)
}

function hasEmptyContentList(m: WrittenMessage): boolean {
  if (m.type !== 'user' && m.type !== 'assistant') return false
  const content: unknown = m.message?.content
  return Array.isArray(content) && content.length === 0
}

type MaybeVirtual = WrittenMessage & { isVirtual?: unknown }

// A virtual message is synthesized locally, but once it is in the transcript
// it is part of the conversation: a resumed session must not treat it as
// synthetic. The caller's message keeps its flag.
function asRealMessage(m: WrittenMessage): WrittenMessage {
  const flagged: MaybeVirtual = m
  if (flagged.isVirtual !== true) return m
  const { isVirtual: _isVirtual, ...real } = flagged
  return real as WrittenMessage
}

/**
 * The messages a transcript write keeps, in their order. `_allMessages` is
 * accepted for the callers that pass the whole conversation; it changes
 * nothing.
 */
export function cleanMessagesForLogging(
  messages: Message[],
  _allMessages?: readonly Message[],
): WrittenMessage[] {
  return messages
    .filter(isWritten)
    .filter(m => !hasEmptyContentList(m))
    .map(asRealMessage)
}
