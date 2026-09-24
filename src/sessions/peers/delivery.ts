/**
 * The receiving end of the peer inbox: what happens to a frame another
 * session sent once its token checked out.
 */
import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'
import type { QueuedCommand } from 'src/shared/types/textInputTypes.js'
import {
  cleanClaimedName,
  formatUdsAddress,
  parseAddress,
} from 'src/sessions/peers/address.js'
import { sendFrame } from 'src/sessions/peers/client.js'
import { formatPeerMessage, type PeerSender } from 'src/sessions/peers/envelope.js'
import { FRAME_VERSION, type ResponseFrame } from 'src/sessions/peers/frames.js'
import {
  HOLD_CAPACITY,
  HOLD_EXPIRY_MS,
  holdPeerMessage,
  takeHeldPeerMessage,
} from 'src/sessions/peers/heldMessages.js'
import type { InboundFrame, InboxHandler } from 'src/sessions/peers/inboxServer.js'
import {
  type DeliveryStatus,
  formatDeliveryNotice,
  takePendingHold,
} from 'src/sessions/peers/notices.js'
import {
  decideInbound,
  type InboundSetting,
  permissionClassOf,
} from 'src/sessions/peers/policy.js'
import type { SessionDirectory } from 'src/sessions/peers/registry.js'

export type InboundDeps = {
  enqueue(command: QueuedCommand): void
  readDirectory(): Promise<SessionDirectory>
  /** This session's permission mode as it is when a message arrives. */
  permissionMode(): PermissionMode
  inboundSetting(): InboundSetting | undefined
  /** This session's inbox address: the `from` of a status it sends back. */
  ownAddress(): string | undefined
  send?: typeof sendFrame
  holdExpiryMs?: number
}

export type InboundDelivery = {
  handler: InboxHandler
  /** This session's user answered a held message, or it ran out of time. */
  settleHeld(id: string, decision: 'deliver' | 'deny' | 'expire'): Promise<void>
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

const STATUS_OF: Record<'deliver' | 'deny' | 'expire', DeliveryStatus> = {
  deliver: 'delivered',
  deny: 'denied',
  expire: 'expired',
}

/**
 * A message lands in this session's queue — at its next tool round when a
 * turn is running, or as a new turn when idle, the path a background agent's
 * completion takes — unless policy holds it for this session's user or
 * refuses it. A held message's outcome goes back to its sender.
 */
export function createInboundDelivery(deps: InboundDeps): InboundDelivery {
  const send = deps.send ?? sendFrame

  async function tellSender(
    sender: PeerSender,
    origMsgId: string,
    status: DeliveryStatus,
  ): Promise<void> {
    if (!sender.address) return
    const directory = await deps.readDirectory()
    const target = directory.peers.find(
      peer => formatUdsAddress(peer.socketPath) === sender.address,
    )
    if (!target) return
    try {
      await send(target.socketPath, {
        v: FRAME_VERSION,
        type: 'delivery_status',
        msg_id: randomUUID(),
        token: target.token,
        from: deps.ownAddress(),
        from_name: directory.self.name,
        orig_msg_id: origMsgId,
        status,
      })
    } catch (e) {
      logForDebugging(
        `[peers] could not tell ${sender.name} its message was ${status}: ${errorMessage(e)}`,
      )
    }
  }

  async function settleHeld(
    id: string,
    decision: 'deliver' | 'deny' | 'expire',
  ): Promise<void> {
    const message = takeHeldPeerMessage(id)
    if (!message) return
    if (decision === 'deliver') deps.enqueue(message.command)
    await tellSender(message.sender, id, STATUS_OF[decision])
  }

  async function receiveMessage(
    frame: Extract<InboundFrame, { type: 'message' }>,
  ): Promise<ResponseFrame> {
    const sender = await identifySender(frame, deps.readDirectory)
    const agent = cleanClaimedName(frame.from_agent)
    const command: QueuedCommand = {
      value: formatPeerMessage({ ...sender, agent }, frame.text),
      mode: 'task-notification',
      priority: 'next',
      skipSlashCommands: true,
      origin: { kind: 'peer', name: sender.name, from: sender.address },
    }
    const decision = decideInbound({
      setting: deps.inboundSetting(),
      sender: frame.from_mode,
      receiver: permissionClassOf(deps.permissionMode()),
    })
    if (decision.action === 'deliver') {
      deps.enqueue(command)
      return { ok: true, outcome: 'delivered' }
    }
    if (decision.action === 'refuse') {
      return { ok: false, outcome: 'refused', detail: decision.toSender }
    }
    const expiryMs = deps.holdExpiryMs ?? HOLD_EXPIRY_MS
    const held = holdPeerMessage({
      id: frame.msg_id,
      sender: { ...sender, agent },
      reason: decision.reason,
      body: frame.text,
      command,
      expiresAt: Date.now() + expiryMs,
    })
    if (!held) {
      return {
        ok: false,
        outcome: 'refused',
        detail: `${HOLD_CAPACITY} messages are already waiting for that session's user`,
      }
    }
    setTimeout(() => void settleHeld(frame.msg_id, 'expire'), expiryMs).unref()
    return { ok: true, outcome: 'held', detail: decision.toSender }
  }

  /** A status is only believed when it answers a send this session is waiting on. */
  function receiveStatus(
    frame: Extract<InboundFrame, { type: 'delivery_status' }>,
  ): ResponseFrame {
    const pending = takePendingHold(frame.orig_msg_id)
    if (pending) {
      deps.enqueue({
        value: formatDeliveryNotice(pending.peerName, frame.status),
        mode: 'task-notification',
        // A notice waits for the turn to end rather than cutting into it.
        priority: 'later',
        skipSlashCommands: true,
        origin: { kind: 'peer-notice', name: pending.peerName },
      })
    }
    return { ok: true }
  }

  return {
    settleHeld,
    handler: async frame => {
      switch (frame.type) {
        case 'message':
          return receiveMessage(frame)
        case 'delivery_status':
          return receiveStatus(frame)
      }
    },
  }
}
