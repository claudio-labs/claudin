/**
 * The receiving end of the peer inbox: what happens to a frame another
 * session sent once its token checked out.
 */
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import {
  cleanClaimedName,
  formatUdsAddress,
  parseAddress,
} from 'src/sessions/peers/address.js'
import { formatPeerMessage, type PeerSender } from 'src/sessions/peers/envelope.js'
import type { ResponseFrame } from 'src/sessions/peers/frames.js'
import type { InboundFrame, InboxHandler } from 'src/sessions/peers/inboxServer.js'
import type { SessionDirectory } from 'src/sessions/peers/registry.js'

export type InboundDeps = {
  enqueue(command: QueuedCommand): void
  readDirectory(): Promise<SessionDirectory>
}

/**
 * Who sent a frame. The reply address and the name come from the session
 * directory when a live session advertises the claimed `from`; otherwise the
 * claim is shown as one and there is nothing to reply to.
 */
export async function identifySender(
  frame: InboundFrame,
  readDirectory: () => Promise<SessionDirectory>,
): Promise<PeerSender> {
  const claimed = `${cleanClaimedName(frame.from_name) ?? 'another session'} (unverified)`
  if (!frame.from) return { name: claimed }
  const address = parseAddress(frame.from)
  if (address.scheme !== 'uds') return { name: claimed }
  const { peers } = await readDirectory()
  const peer = peers.find(p => p.socketPath === address.target)
  return peer
    ? { address: formatUdsAddress(peer.socketPath), name: peer.name }
    : { name: claimed }
}

async function deliverMessage(
  frame: Extract<InboundFrame, { type: 'message' }>,
  deps: InboundDeps,
): Promise<ResponseFrame> {
  const sender = await identifySender(frame, deps.readDirectory)
  const agent = cleanClaimedName(frame.from_agent)
  deps.enqueue({
    value: formatPeerMessage({ ...sender, agent }, frame.text),
    mode: 'task-notification',
    priority: 'next',
    skipSlashCommands: true,
    origin: { kind: 'peer', name: sender.name, from: sender.address },
  })
  return { ok: true, outcome: 'delivered' }
}

/**
 * A message lands in this session's queue: at its next tool round when a turn
 * is running, or as a new turn when idle — the path a background agent's
 * completion takes.
 */
export function createInboxHandler(deps: InboundDeps): InboxHandler {
  return async frame => {
    switch (frame.type) {
      case 'message':
        return deliverMessage(frame, deps)
    }
  }
}
