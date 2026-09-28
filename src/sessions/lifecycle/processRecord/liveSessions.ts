/**
 * The other CLIs running on this machine, read from their records: counted
 * for the startup tips, listed for the resume picker and the sessions screen.
 */
import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'

import { recordFilePid } from 'src/sessions/lifecycle/processRecord/recordFile.js'
import { getSessionsDir } from 'src/sessions/sessionsDir.js'
import { safeParseJSON } from 'src/shared/data/json.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { isProcessRunning } from 'src/shared/proc/genericProcessUtils.js'
import { getPlatform } from 'src/shared/proc/platform.js'

export type LiveSession = {
  pid: number
  sessionId: string
  cwd: string
  turnActive?: boolean
  runningAgents?: number
  costUSD?: number
}

export type LiveSessionDeps = {
  sessionsDir: string
  ownPid: number
  isAlive(pid: number): boolean
}

/**
 * All a reader may take from another session's record: identity and
 * presence. The name, status, bridge id and inbox token never leave it.
 */
const LiveSessionSchema = lazySchema(() =>
  z.object({
    pid: z.number().int(),
    sessionId: z.string(),
    cwd: z.string(),
    turnActive: z.boolean().optional(),
    runningAgents: z.number().optional(),
    costUSD: z.number().optional(),
  }),
)

type RecordFile = { name: string; pid: number }

export async function countConcurrentSessions(): Promise<number> {
  const sessionsDir = getSessionsDir()
  let count = 0
  for (const record of await listRecordFiles(sessionsDir)) {
    // Liveness is all that counts here; the records are not read.
    if (record.pid === process.pid || isProcessRunning(record.pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // A crashed or killed CLI never removes its own record. On WSL the
      // directory may be shared with processes this probe cannot see.
      void removeStaleRecord(join(sessionsDir, record.name))
    }
  }
  return count
}

/** Never deletes anything: a record that looks stale here is left to the count to sweep. */
export async function listLiveSessions(
  deps: LiveSessionDeps = defaultLiveSessionDeps(),
): Promise<LiveSession[]> {
  const others = (await listRecordFiles(deps.sessionsDir)).filter(
    record => record.pid !== deps.ownPid && deps.isAlive(record.pid),
  )
  const sessions = await Promise.all(
    others.map(record => readLiveSession(join(deps.sessionsDir, record.name))),
  )
  return sessions.filter(session => session !== undefined)
}

function defaultLiveSessionDeps(): LiveSessionDeps {
  return { sessionsDir: getSessionsDir(), ownPid: process.pid, isAlive: isProcessRunning }
}

async function listRecordFiles(sessionsDir: string): Promise<RecordFile[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`Cannot list the session records in ${sessionsDir}: ${errorMessage(error)}`)
    }
    return []
  }
  return names.flatMap(name => {
    const pid = recordFilePid(name)
    return pid === undefined ? [] : [{ name, pid }]
  })
}

async function readLiveSession(path: string): Promise<LiveSession | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    logForDebugging(`Skipping the unreadable session record ${path}: ${errorMessage(error)}`)
    return undefined
  }
  const parsed = LiveSessionSchema().safeParse(safeParseJSON(text, false))
  if (!parsed.success) {
    logForDebugging(`Skipping the session record ${path}: it is not a session record`)
    return undefined
  }
  return parsed.data
}

async function removeStaleRecord(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    logForDebugging(`The stale session record ${path} was not removed: ${errorMessage(error)}`)
  }
}
