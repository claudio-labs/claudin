import type { PermissionMode } from 'src/shared/types/permissions.js'
import type { PermissionClass } from 'src/sessions/peers/frames.js'

/** `crossSessionInbound` in settings.json. */
export type InboundSetting = 'accept' | 'hold' | 'refuse'

export type InboundDecision =
  | { action: 'deliver' }
  | {
      action: 'hold' | 'refuse'
      /** For this session's user: finishes "Held because …". */
      reason: string
      /** For the sender, told in the answer to its send. */
      toSender: string
    }

/**
 * The side of the permission line a session is on: `bypass` runs tools
 * without asking anyone, every other mode still stops for its user.
 */
export function permissionClassOf(mode: PermissionMode): PermissionClass {
  return mode === 'bypassPermissions' ? 'bypass' : 'prompting'
}

type SettingsSourceName =
  | 'policySettings'
  | 'flagSettings'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'

const STRICTNESS: Record<InboundSetting, number> = { accept: 0, hold: 1, refuse: 2 }

/**
 * `crossSessionInbound` as this session obeys it. Policy, a flag or the user
 * decide, in that order; the repository's own settings may only make it
 * stricter, so a cloned project cannot open a session to its neighbours.
 */
export function resolveInboundSetting(
  read: (source: SettingsSourceName) => InboundSetting | undefined,
): InboundSetting | undefined {
  let setting = read('policySettings') ?? read('flagSettings') ?? read('userSettings')
  for (const repo of [read('projectSettings'), read('localSettings')]) {
    if (repo === undefined || repo === 'accept') continue
    if (setting === undefined || STRICTNESS[repo] > STRICTNESS[setting]) setting = repo
  }
  return setting
}

/**
 * What to do with a message another session sent. With no setting it is
 * mode parity: deliver when both ends sit on the same side of the permission
 * line, hold for this session's user when they do not — a session that asks
 * before acting must not be able to get one that does not to act for it, and
 * the reverse is just as much a change of who decides.
 */
export function decideInbound({
  setting,
  sender,
  receiver,
}: {
  setting: InboundSetting | undefined
  sender: PermissionClass | undefined
  receiver: PermissionClass
}): InboundDecision {
  switch (setting) {
    case 'refuse':
      return {
        action: 'refuse',
        reason: 'this session refuses messages from other sessions (crossSessionInbound: refuse)',
        toSender: 'that session refuses messages from other sessions',
      }
    case 'hold':
      return {
        action: 'hold',
        reason: 'this session holds every message from another session for you (crossSessionInbound: hold)',
        toSender: 'that session holds every message from another session for its user',
      }
    case 'accept':
      return { action: 'deliver' }
  }
  if (sender === undefined) {
    return receiver === 'bypass'
      ? {
          action: 'hold',
          reason: 'the sender did not say how it handles permissions, and this session runs with them bypassed',
          toSender: 'that session runs with permissions bypassed and could not tell how yours runs',
        }
      : { action: 'deliver' }
  }
  if (sender === receiver) return { action: 'deliver' }
  return {
    action: 'hold',
    reason:
      sender === 'bypass'
        ? 'the sender runs with permissions bypassed and this session does not'
        : 'this session runs with permissions bypassed and the sender does not',
    toSender: 'that session and yours are on different sides of bypassPermissions',
  }
}
