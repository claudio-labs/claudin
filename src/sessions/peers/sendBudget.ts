import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'

/**
 * How many messages this session may send to other sessions before its user
 * writes again. Two sessions answering each other would otherwise loop
 * forever: a message reaching an idle session opens a turn with no human in
 * it, so only a prompt the user typed resets the count.
 */
export const CROSS_SESSION_SENDS_PER_USER_PROMPT = 10

let sent = 0

/** Spend one send; false once the budget is gone. */
export function takeCrossSessionSend(): boolean {
  if (sent >= CROSS_SESSION_SENDS_PER_USER_PROMPT) return false
  sent += 1
  return true
}

export function resetCrossSessionSends(): void {
  sent = 0
}

/**
 * Renew the budget when a batch of queued commands holds a prompt the user
 * typed. A turn another session's message or a notification opened does not
 * count — that is the loop the budget exists to stop.
 */
export function renewCrossSessionSendsFor(
  commands: ReadonlyArray<Pick<QueuedCommand, 'mode' | 'origin'>>,
): void {
  if (commands.some(cmd => cmd.mode === 'prompt' && cmd.origin === undefined)) {
    resetCrossSessionSends()
  }
}
