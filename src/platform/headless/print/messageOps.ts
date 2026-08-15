import type { Message, NormalizedUserMessage } from 'src/shared/types/message.js'

/**
 * Removes an interrupted user message and its synthetic assistant sentinel
 * from the message array. Used during gateway-triggered restarts to clean up
 * the message history before re-enqueuing the interrupted prompt.
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // Remove the user message and the sentinel that immediately follows it.
    // splice safely handles the case where idx is the last element.
    messages.splice(idx, 2)
  }
}
