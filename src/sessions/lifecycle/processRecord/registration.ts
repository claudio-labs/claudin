/**
 * Registering this CLI in `<config dir>/sessions/`, so that other instances
 * can count it, list it and reach it.
 */
import { chmod, mkdir, rm } from 'fs/promises'

import { getAgentId } from 'src/agent/coordinator/teammate.js'
import { getOriginalCwd, getSessionId, onSessionSwitch } from 'src/platform/bootstrap/state.js'
import { newProcessRecord, recordPath } from 'src/sessions/lifecycle/processRecord/recordFile.js'
import { patchRecord } from 'src/sessions/lifecycle/processRecord/recordUpdates.js'
import { writePidRecord } from 'src/sessions/pidRecord.js'
import { getSessionsDir } from 'src/sessions/sessionsDir.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'

/** The records carry the peer inbox token: only this user may list or read them. */
const OWNER_ONLY = 0o700

/** Settles once, with the outcome of the process's first registration attempt. */
const firstAttempt = Promise.withResolvers<boolean>()
let stopFollowingSwitches: (() => void) | undefined
let cancelRemovalAtShutdown: (() => void) | undefined

export async function registerSession(): Promise<boolean> {
  const registered = await writeOwnRecord()
  firstAttempt.resolve(registered)
  return registered
}

export function whenSessionRegistered(): Promise<boolean> {
  return firstAttempt.promise
}

async function writeOwnRecord(): Promise<boolean> {
  // A teammate works inside another session's swarm, and that session is the one others see.
  if (getAgentId()) return false
  const sessionsDir = getSessionsDir()
  const path = recordPath(sessionsDir, process.pid)
  try {
    await mkdir(sessionsDir, { recursive: true, mode: OWNER_ONLY })
    // mkdir leaves an existing directory's mode alone, and an older one may be readable by others.
    await chmod(sessionsDir, OWNER_ONLY)
    await writePidRecord(
      path,
      newProcessRecord({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      }),
    )
  } catch (error) {
    logForDebugging(`This session was not registered in ${sessionsDir}: ${errorMessage(error)}`)
    return false
  }
  followSessionSwitches(path)
  removeAtShutdown(path)
  return true
}

/** /resume and /clear switch the session under the running process; the record follows. */
function followSessionSwitches(path: string): void {
  stopFollowingSwitches?.()
  stopFollowingSwitches = onSessionSwitch(sessionId => {
    void patchRecord(path, { sessionId })
  })
}

function removeAtShutdown(path: string): void {
  cancelRemovalAtShutdown?.()
  cancelRemovalAtShutdown = registerCleanup(async () => {
    try {
      await rm(path, { force: true })
    } catch (error) {
      logForDebugging(`The session record ${path} was not removed: ${errorMessage(error)}`)
    }
  })
}
