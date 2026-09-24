/**
 * The other Claudin sessions on this machine, read from the PID files every
 * session keeps in ~/.claudin/sessions. That directory is the allowlist: a
 * send only ever goes to a socket some live session advertises there, so no
 * address the model writes can point a frame at an arbitrary socket.
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { jsonParse } from 'src/platform/slowOperations.js'
import { getSessionsDir } from 'src/sessions/sessionsDir.js'
import {
  parseAddress,
  parsePeerTarget,
  sessionDisplayName,
  sessionRefHash,
  shortestUniqueRef,
} from 'src/sessions/peers/address.js'
import { pingInbox } from 'src/sessions/peers/client.js'
import { isOwnedSocket } from 'src/sessions/peers/socketPath.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isFsInaccessible } from 'src/shared/errors.js'
import { isProcessRunning } from 'src/shared/proc/genericProcessUtils.js'

export type PeerSession = {
  pid: number
  /** The address, as ListAgents prints it and a send resolves it. */
  name: string
  /** sha256 of the socket path; `ref` is its shortest unique prefix. */
  hash: string
  ref: string
  socketPath: string
  token: string
  cwd: string
  startedAt: number
  status?: 'busy' | 'idle'
}

export type SessionDirectory = {
  /** This session's own name and ref — the ref only when it has an inbox. */
  self: { name: string; ref?: string }
  peers: PeerSession[]
}

const PID_FILE_RE = /^(\d+)\.json$/

const RecordSchema = lazySchema(() =>
  z.object({
    pid: z.number().int(),
    cwd: z.string(),
    startedAt: z.number(),
    name: z.string().optional(),
    messagingSocketPath: z.string().nullish(),
    messagingToken: z.string().nullish(),
    status: z.enum(['busy', 'idle']).optional(),
  }),
)
type SessionRecordView = z.infer<ReturnType<typeof RecordSchema>>

export type DirectoryDeps = {
  sessionsDir: string
  ownPid: number
  ownCwd: string
  isAlive(pid: number): boolean
  isOwnedSocket(path: string): Promise<boolean>
  ping(socketPath: string, token: string): Promise<boolean>
}

function defaultDeps(): DirectoryDeps {
  return {
    sessionsDir: getSessionsDir(),
    ownPid: process.pid,
    ownCwd: getOriginalCwd(),
    isAlive: isProcessRunning,
    isOwnedSocket,
    ping: pingInbox,
  }
}

async function readRecords(dir: string): Promise<SessionRecordView[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[peers] readdir ${dir} failed: ${errorMessage(e)}`)
    }
    return []
  }
  const records: SessionRecordView[] = []
  for (const name of names) {
    if (!PID_FILE_RE.test(name)) continue
    try {
      const parsed = RecordSchema().safeParse(
        jsonParse(await readFile(join(dir, name), 'utf8')),
      )
      if (parsed.success) records.push(parsed.data)
    } catch (e) {
      // A record vanishing between readdir and read is a session exiting.
      logForDebugging(`[peers] skipped ${name}: ${errorMessage(e)}`)
    }
  }
  return records
}

/**
 * This session and the reachable others. `probe` pings each inbox (250 ms) so
 * a listing never shows a session that cannot answer; a send skips it, since
 * the send itself finds out.
 */
export async function readSessionDirectory(
  { probe = false }: { probe?: boolean } = {},
  deps: DirectoryDeps = defaultDeps(),
): Promise<SessionDirectory> {
  const records = await readRecords(deps.sessionsDir)
  const own = records.find(record => record.pid === deps.ownPid)
  const reachable: PeerSession[] = []
  for (const record of records) {
    const { pid, messagingSocketPath: socketPath, messagingToken: token } = record
    if (pid === deps.ownPid || !socketPath || !token || !deps.isAlive(pid)) continue
    if (!(await deps.isOwnedSocket(socketPath))) continue
    if (probe && !(await deps.ping(socketPath, token))) continue
    reachable.push({
      pid,
      name: sessionDisplayName(record.name, record.cwd),
      hash: sessionRefHash(socketPath),
      ref: '',
      socketPath,
      token,
      cwd: record.cwd,
      startedAt: record.startedAt,
      status: record.status,
    })
  }
  reachable.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)

  const ownHash = own?.messagingSocketPath
    ? sessionRefHash(own.messagingSocketPath)
    : undefined
  const hashes = [...reachable.map(peer => peer.hash), ...(ownHash ? [ownHash] : [])]
  for (const peer of reachable) peer.ref = shortestUniqueRef(peer.hash, hashes)
  return {
    self: {
      name: sessionDisplayName(own?.name, own?.cwd ?? deps.ownCwd),
      ref: ownHash ? shortestUniqueRef(ownHash, hashes) : undefined,
    },
    peers: reachable,
  }
}

export type PeerResolution =
  | { peer: PeerSession }
  | { error: string }
  | { notAPeer: true }

/**
 * Match a SendMessage `to` against the listed sessions: a `uds:` address (a
 * reply to a `from`), `name [ref]`, or a bare name. `notAPeer` hands the name
 * back to the caller's other routes.
 */
export function resolvePeerTarget(
  to: string,
  peers: readonly PeerSession[],
): PeerResolution {
  const address = parseAddress(to)
  if (address.scheme === 'uds') {
    const peer = peers.find(p => p.socketPath === address.target)
    return peer
      ? { peer }
      : { error: 'No session is listening at that address any more — ListAgents shows the ones that are.' }
  }
  const { name, ref } = parsePeerTarget(to)
  const named = peers.filter(peer => peer.name === name)
  const matches = ref ? named.filter(peer => peer.hash.startsWith(ref)) : named
  if (matches.length === 1) return { peer: matches[0]! }
  if (matches.length > 1) {
    const options = matches.map(peer => `"${peer.name} [${peer.ref}]"`).join(', ')
    return { error: `"${name}" names ${matches.length} sessions — send to one of ${options}.` }
  }
  if (ref) {
    return {
      error: `No session "${name}" has the ref [${ref}] — a ref only resolves when you read it from ListAgents or an error just now.`,
    }
  }
  return { notAPeer: true }
}
