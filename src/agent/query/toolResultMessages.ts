import type {
  AttachmentMessage,
  Message,
  UserMessage,
} from 'src/shared/types/message.js'

/**
 * What a message a tool yielded adds to the next request of the same turn:
 * the message itself, unchanged, when the API render reads it (a tool_result
 * or other user message, an attachment); nothing otherwise (progress, and the
 * skill path's warning — the render drops both).
 *
 * Unchanged is the point. The REPL and the transcript keep these messages as
 * the tool yielded them, and from the next turn on (and after --resume)
 * normalizeMessagesForAPI renders them in context, with the whole array — so
 * the turn has to hand the request the same messages, rendered once, by the
 * same call. Until 2026-10-01 the loop rendered each one ALONE here and kept
 * the result: an attachment rendered alone is already a plain user message,
 * which reorderAttachmentsForAPI can no longer bubble up into its tool_result.
 * A Skill whose prompt command emitted turn-start attachments (task_reconcile,
 * auto_mode), or a PostToolUse hook's additional context, went out in-turn as
 * a text block after the tool_result and from the next turn on inside it.
 * Opus 5.5 binds every thinking block to the bytes before it, so the server
 * dropped the thinking after that message (input_transformations:
 * prefix_binding_mismatch) and wrote the prefix from there again — 9
 * turn-opening rewrites, ~3.9M tokens, over 09-14..10-01.
 */
export function toolMessagesForNextRequest(
  message: Message,
): (UserMessage | AttachmentMessage)[] {
  return message.type === 'user' || message.type === 'attachment'
    ? [message]
    : []
}
