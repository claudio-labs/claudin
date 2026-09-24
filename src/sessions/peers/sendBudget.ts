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
