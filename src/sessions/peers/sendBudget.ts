import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'

/**
 * How many messages this session may send to other sessions before its user
 * writes again. Two sessions answering each other would otherwise loop
 * forever: a message reaching an idle session opens a turn with no human in
 * it, so only a prompt the user typed resets the count.
 */
export const CROSS_SESSION_SENDS_PER_USER_PROMPT = 10

/**
 * How many messages one agent may send to the other agents of its own
 * conversation: over its whole life for a sub-agent, per user prompt for the
 * main conversation. Two agents answering each other with `await_reply` would
 * otherwise loop with no human in it. Generous on purpose — a dev/tester pair
 * trading fixes and re-tests spends two per round.
 */
export const AGENT_SENDS_PER_AGENT = 50

const MAIN_SENDER = 'main'

let sent = 0
const agentSends = new Map<string, number>()

/** Spend one send; false once the budget is gone. */
export function takeCrossSessionSend(): boolean {
  if (sent >= CROSS_SESSION_SENDS_PER_USER_PROMPT) return false
  sent += 1
  return true
}

/** Spend one of `sender`'s sends (an agentId, or "main"); false once gone. */
export function takeAgentSend(sender: string): boolean {
  const spent = agentSends.get(sender) ?? 0
  if (spent >= AGENT_SENDS_PER_AGENT) return false
  agentSends.set(sender, spent + 1)
  return true
}

/** What a prompt the user typed renews: both of main's budgets. */
export function resetCrossSessionSends(): void {
  sent = 0
  agentSends.delete(MAIN_SENDER)
}

export function resetAgentSendsForTesting(): void {
  agentSends.clear()
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
