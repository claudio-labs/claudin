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
  formatIdleNotice,
  type IdleState,
  takePendingHold,
} from 'src/sessions/peers/notices.js'
import {
  decideInbound,
  type InboundSetting,
  permissionClassOf,
} from 'src/sessions/peers/policy.js'
import type { SessionDirectory } from 'src/sessions/peers/registry.js'
import {
  addIdleSubscription,
  SUBSCRIPTION_TTL_MS,
  takeAllIdleSubscriptions,
  takeAwaitedIdleNotice,
  takeIdleSubscription,
  takeIdleSubscriptions,
  type IdleSubscription,
} from 'src/sessions/peers/subscriptions.js'

export type InboundDeps = {
  enqueue(command: QueuedCommand): void
  readDirectory(): Promise<SessionDirectory>
  /** This session's permission mode as it is when a message arrives. */
  permissionMode(): PermissionMode
  inboundSetting(): InboundSetting | undefined
  /** This session's inbox address: the `from` of a status it sends back. */
  ownAddress(): string | undefined
  /** When this session's current idle stretch began; undefined while busy. */
  idleSince(): number | undefined
  send?: typeof sendFrame
  holdExpiryMs?: number
  subscriptionTtlMs?: number
}

export type InboundDelivery = {
  handler: InboxHandler
  /** This session's user answered a held message, or it ran out of time. */
  settleHeld(id: string, decision: 'deliver' | 'deny' | 'expire'): Promise<void>
  /** This session went idle at `idleSince`: answer the subscriptions it settles. */
  notifyIdle(idleSince: number): Promise<void>
  /** This session is exiting: answer every subscription. */
  notifyExit(): Promise<void>
}

/**
 * Who sent a frame. The reply address and the name come from the session
 * directory when a live session advertises the claimed `from`; otherwise the
 * claim is shown as one and there is nothing to reply to.
 */
async function identifySender(
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

  /** Send a frame to the session at `address` — only one some live session advertises. */
  async function sendTo(
    address: string,
    frame: (auth: { token: string; from?: string; from_name: string }) => Parameters<typeof send>[1],
    what: string,
    timeoutMs?: number,
  ): Promise<void> {
    const directory = await deps.readDirectory()
    const target = directory.peers.find(peer => formatUdsAddress(peer.socketPath) === address)
    if (!target) return
    try {
      await send(
        target.socketPath,
        frame({ token: target.token, from: deps.ownAddress(), from_name: directory.self.name }),
        timeoutMs,
      )
    } catch (e) {
      logForDebugging(`[peers] could not send ${what} to ${target.name}: ${errorMessage(e)}`)
    }
  }

  async function tellSender(
    sender: PeerSender,
    origMsgId: string,
    status: DeliveryStatus,
  ): Promise<void> {
    if (!sender.address) return
    await sendTo(
      sender.address,
      auth => ({
        v: FRAME_VERSION,
        type: 'delivery_status',
        msg_id: randomUUID(),
        ...auth,
        orig_msg_id: origMsgId,
        status,
      }),
      `a ${status} status`,
    )
  }

  async function sendIdleNotice(
    subscription: IdleSubscription,
    state: IdleState,
    finishedAt?: number,
    timeoutMs?: number,
  ): Promise<void> {
    await sendTo(
      formatUdsAddress(subscription.socketPath),
      auth => ({
        v: FRAME_VERSION,
        type: 'idle_notice',
        msg_id: randomUUID(),
        ...auth,
        orig_msg_id: subscription.id,
        state,
        finished_at: finishedAt,
      }),
      `an ${state} notice`,
      timeoutMs,
    )
  }

  /**
   * Take a subscription from a verified sender. A pure subscription made
   * while this session is already idle is answered at once — "tell me when
   * you are free" while free.
   */
  function subscribe(
    msgId: string,
    sender: PeerSender,
    { pure }: { pure: boolean },
  ): { subscribed: boolean; detail?: string } {
    const address = sender.address ? parseAddress(sender.address) : undefined
    if (!address || address.scheme !== 'uds') {
      return { subscribed: false, detail: 'no idle notice: that session could not verify where to send it' }
    }
    const subscription = { id: msgId, socketPath: address.target, createdAt: Date.now() }
    if (!addIdleSubscription(subscription)) {
      return { subscribed: false, detail: 'no idle notice: that session already has too many subscriptions' }
    }
    setTimeout(() => {
      const expired = takeIdleSubscription(msgId)
      if (expired) void sendIdleNotice(expired, 'expired')
    }, deps.subscriptionTtlMs ?? SUBSCRIPTION_TTL_MS).unref()
    const idleSince = deps.idleSince()
    if (pure && idleSince !== undefined) {
      takeIdleSubscription(msgId)
      void sendIdleNotice(subscription, 'idle', idleSince)
    }
    return { subscribed: true }
  }

  async function settleHeld(
    id: string,
    decision: 'deliver' | 'deny' | 'expire',
  ): Promise<void> {
    const message = takeHeldPeerMessage(id)
    if (!message) return
    if (decision === 'deliver') deps.enqueue(message.command)
    // A subscription that rode on a message nobody will read has nothing to report.
    else takeIdleSubscription(id)
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
    if (decision.action === 'refuse') {
      return { ok: false, outcome: 'refused', detail: decision.toSender }
    }
    const subscription = frame.notify_when_idle
      ? subscribe(frame.msg_id, sender, { pure: false })
      : undefined
    if (decision.action === 'deliver') {
      deps.enqueue(command)
      return { ok: true, outcome: 'delivered', ...subscription }
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
      takeIdleSubscription(frame.msg_id)
      return {
        ok: false,
        outcome: 'refused',
        detail: `${HOLD_CAPACITY} messages are already waiting for that session's user`,
      }
    }
    setTimeout(() => void settleHeld(frame.msg_id, 'expire'), expiryMs).unref()
    return { ok: true, outcome: 'held', detail: decision.toSender, subscribed: subscription?.subscribed }
  }

  async function receiveSubscription(
    frame: Extract<InboundFrame, { type: 'notify_when_idle' }>,
  ): Promise<ResponseFrame> {
    if (deps.inboundSetting() === 'refuse') {
      return { ok: false, outcome: 'refused', detail: 'that session refuses messages from other sessions' }
    }
    const sender = await identifySender(frame, deps.readDirectory)
    const { subscribed, detail } = subscribe(frame.msg_id, sender, { pure: true })
    return subscribed
      ? { ok: true, outcome: 'subscribed', subscribed }
      : { ok: false, outcome: 'refused', detail, subscribed }
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

  function receiveIdleNotice(
    frame: Extract<InboundFrame, { type: 'idle_notice' }>,
  ): ResponseFrame {
    const awaited = takeAwaitedIdleNotice(frame.orig_msg_id)
    if (awaited) {
      deps.enqueue({
        value: formatIdleNotice(awaited.peerName, frame.state, frame.finished_at),
        mode: 'task-notification',
        priority: 'later',
        skipSlashCommands: true,
        origin: { kind: 'peer-notice', name: awaited.peerName },
      })
    }
    return { ok: true }
  }

  return {
    settleHeld,
    async notifyIdle(idleSince) {
      await Promise.all(
        takeIdleSubscriptions(idleSince).map(s => sendIdleNotice(s, 'idle', idleSince)),
      )
    },
    async notifyExit() {
      // Inside the exit cleanup's 2s budget: a peer that is slow to answer
      // learns from its socket closing instead.
      await Promise.all(
        takeAllIdleSubscriptions().map(s => sendIdleNotice(s, 'exited', undefined, 500)),
      )
    },
    handler: async frame => {
      switch (frame.type) {
        case 'message':
          return receiveMessage(frame)
        case 'notify_when_idle':
          return receiveSubscription(frame)
        case 'delivery_status':
          return receiveStatus(frame)
        case 'idle_notice':
          return receiveIdleNotice(frame)
      }
    },
  }
}
