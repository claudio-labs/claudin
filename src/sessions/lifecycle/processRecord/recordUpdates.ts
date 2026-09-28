/**
 * Changes to this process's own record. Each merges its fields into the
 * record and keeps the rest; `patchPidRecord` applies them one at a time, so
 * that updates issued together all land.
 */
import {
  ownRecordPath,
  type ProcessRecord,
} from 'src/sessions/lifecycle/processRecord/recordFile.js'
import { patchPidRecord } from 'src/sessions/pidRecord.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'

type RecordPatch = Partial<Omit<ProcessRecord, 'pid' | 'startedAt' | 'kind'>>

/**
 * Merge `patch` into the record at `path`. Without a record there is nothing
 * to update and nothing is created: a teammate never writes one, and neither
 * does a registration that failed.
 */
export async function patchRecord(path: string, patch: RecordPatch): Promise<void> {
  try {
    await patchPidRecord(path, patch)
  } catch (error) {
    logForDebugging(`The session record ${path} was not updated: ${errorMessage(error)}`)
  }
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  if (!name) return
  await patchRecord(ownRecordPath(), { name })
}

export function updateSessionBridgeId(bridgeSessionId: string | null): Promise<void> {
  return patchRecord(ownRecordPath(), { bridgeSessionId })
}

/** Nulls withdraw the inbox: the fields stay, holding null. */
export function updateSessionInbox(inbox: {
  messagingSocketPath: string | null
  messagingToken: string | null
}): Promise<void> {
  return patchRecord(ownRecordPath(), {
    messagingSocketPath: inbox.messagingSocketPath,
    messagingToken: inbox.messagingToken,
  })
}

export function updateSessionCwd(cwd: string): Promise<void> {
  return patchRecord(ownRecordPath(), { cwd })
}

export function updateSessionStatus(status: 'busy' | 'idle'): Promise<void> {
  return patchRecord(ownRecordPath(), { status })
}

export function updateSessionPresence(presence: {
  turnActive: boolean
  runningAgents: number
  costUSD: number
}): Promise<void> {
  return patchRecord(ownRecordPath(), {
    turnActive: presence.turnActive,
    runningAgents: presence.runningAgents,
    costUSD: presence.costUSD,
  })
}
