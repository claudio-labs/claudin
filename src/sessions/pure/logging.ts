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
import { isEnvTruthy } from 'src/shared/envUtils.js'

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
  // IMPORTANT: We deliberately filter out most attachments for non-ants because
  // they have sensitive info for training that we don't want exposed to the public.
  // When enabled, we allow hook_additional_context through since it contains
  // user-configured hook output that is useful for session context on resume.
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    if (
      m.attachment.type === 'hook_additional_context' &&
      isEnvTruthy(process.env.CLAUDIN_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    // deferred_tools_delta must persist (contains only tool names/lines,
    // already public in adjacent tool_use blocks): it is the resume-visible
    // marker maybeLatchLegacyDeferredAnnouncement uses to recognize a
    // delta-format history, the bytes a warm-resumed prefix must reproduce
    // to hit the server-side cache, and the announced-set source that stops
    // getDeferredToolsDelta from re-announcing the full pool after /resume.
    if (m.attachment.type === 'deferred_tools_delta') {
      return true
    }
    return false
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
