/**
 * Messages from other sessions waiting for this session's user to let them
 * through. A store with a subscription, so the REPL's dialog can follow it.
 */
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import type { PeerSender } from 'src/sessions/peers/envelope.js'

export const HOLD_CAPACITY = 100
export const HOLD_EXPIRY_MS = 5 * 60_000

export type HeldPeerMessage = {
  /** The sender's msg_id — what its delivery notice refers back to. */
  id: string
  sender: PeerSender
  /** Why policy held it, finishing the sentence "Held because …". */
  reason: string
  body: string
  /** What delivering it enqueues, built when it arrived. */
  command: QueuedCommand
  expiresAt: number
}

let held: readonly HeldPeerMessage[] = []
const listeners = new Set<() => void>()

function publish(next: readonly HeldPeerMessage[]): void {
  held = next
  for (const listener of listeners) listener()
}

/** False once HOLD_CAPACITY messages are already waiting. */
export function holdPeerMessage(message: HeldPeerMessage): boolean {
  if (held.length >= HOLD_CAPACITY) return false
  publish([...held, message])
  return true
}

/** Remove a held message and return it — undefined when it was already settled. */
export function takeHeldPeerMessage(id: string): HeldPeerMessage | undefined {
  const message = held.find(m => m.id === id)
  if (message) publish(held.filter(m => m !== message))
  return message
}

export function getHeldPeerMessages(): readonly HeldPeerMessage[] {
  return held
}

export function subscribeHeldPeerMessages(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
