/**
 * The record each running CLI keeps at `<config dir>/sessions/<pid>.json`.
 * Other instances read it (peers/registry.ts, and other installed versions of
 * the CLI), so its file name and field names are a contract.
 */
import { join } from 'path'

import { getSessionsDir } from 'src/sessions/sessionsDir.js'

export type ProcessRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: 'interactive'
  entrypoint?: string
  name?: string
  bridgeSessionId?: string | null
  messagingSocketPath?: string | null
  messagingToken?: string | null
  status?: 'busy' | 'idle'
  turnActive?: boolean
  runningAgents?: number
  costUSD?: number
}

/** `<digits>.json`, exactly: every other name in the directory is left alone. */
const RECORD_FILE_NAME = /^(\d+)\.json$/

export function recordPath(sessionsDir: string, pid: number): string {
  return join(sessionsDir, `${pid}.json`)
}

export function ownRecordPath(): string {
  return recordPath(getSessionsDir(), process.pid)
}

/** The pid a record file is named after, or undefined for any other file. */
export function recordFilePid(fileName: string): number | undefined {
  const match = RECORD_FILE_NAME.exec(fileName)
  return match ? Number(match[1]) : undefined
}

export function newProcessRecord(identity: {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  entrypoint: string | undefined
}): ProcessRecord {
  const { pid, sessionId, cwd, startedAt, entrypoint } = identity
  // `entrypoint` names the host that launched the CLI (an IDE, the SDK). When
  // the host does not say, it is undefined and the JSON record has no such key.
  return { pid, sessionId, cwd, startedAt, kind: 'interactive', entrypoint }
}
