/**
 * The peer inbox: the Unix socket other Claudin sessions on this machine write
 * to when they SendMessage to this session's name. Only the interactive REPL
 * binds one; a headless run can send but not receive.
 *
 * Two fences: the socket is 0600 inside a 0700 directory, and every request
 * carries the token from this session's PID file, which only this user can
 * read. On by default — CLAUDIN_DISABLE_CROSS_SESSION=1 binds nothing, lists
 * no peers and refuses every send to one. Not available on Windows, whose
 * named pipes have no file mode to lean on.
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import { chmod, readdir, unlink } from 'fs/promises'
import { createServer, type Socket } from 'net'
import { basename, dirname, join } from 'path'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { isProcessRunning } from 'src/shared/proc/genericProcessUtils.js'
import {
  decodeRequest,
  encodeFrame,
  MAX_FRAME_BYTES,
  type RequestFrame,
  type ResponseFrame,
} from 'src/sessions/peers/frames.js'
import {
  ensurePrivateSocketDir,
  socketPathFor,
} from 'src/sessions/peers/socketPath.js'

const IDLE_CONNECTION_MS = 30_000
const SOCKET_FILE_RE = /^(\d+)\.sock$/

export type InboundFrame = Exclude<RequestFrame, { type: 'ping' }>
export type InboxHandler = (frame: InboundFrame) => Promise<ResponseFrame>

export type PeerInbox = {
  socketPath: string
  token: string
  close(): Promise<void>
}

let ownInbox: PeerInbox | undefined

/** This session's inbox, once bound. */
export function getOwnInbox(): PeerInbox | undefined {
  return ownInbox
}

/** Why this session cannot message other sessions, or undefined when it can. */
export function crossSessionUnavailableReason(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform === 'win32') {
    return 'Messaging other sessions is not available on Windows in this version.'
  }
  if (isEnvTruthy(env.CLAUDIN_DISABLE_CROSS_SESSION)) {
    return 'Messaging other sessions is switched off here (CLAUDIN_DISABLE_CROSS_SESSION).'
  }
  return undefined
}

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function serveConnection(
  connection: Socket,
  token: string,
  handler: InboxHandler,
): void {
  let buffer = ''
  let answered = false
  const answer = (response: ResponseFrame): void => {
    if (answered) return
    answered = true
    connection.end(encodeFrame(response))
  }
  connection.setTimeout(IDLE_CONNECTION_MS, () => connection.destroy())
  connection.on('error', error =>
    logForDebugging(`[peers] inbox connection error: ${error.message}`),
  )
  connection.on('data', chunk => {
    if (answered) return
    buffer += chunk.toString('utf8')
    const end = buffer.indexOf('\n')
    if (end === -1) {
      if (buffer.length > MAX_FRAME_BYTES) {
        answer({ ok: false, outcome: 'refused', detail: 'frame too large' })
      }
      return
    }
    const decoded = decodeRequest(buffer.slice(0, end))
    if ('error' in decoded) {
      answer({ ok: false, outcome: 'refused', detail: decoded.error })
      return
    }
    const { frame } = decoded
    if (!tokensMatch(frame.token, token)) {
      answer({ ok: false, outcome: 'refused', detail: 'wrong token for this inbox' })
      return
    }
    if (frame.type === 'ping') {
      answer({ ok: true, outcome: 'pong' })
      return
    }
    handler(frame).then(answer, (error: unknown) => {
      logError(error)
      answer({
        ok: false,
        outcome: 'refused',
        detail: 'the receiving session failed to take the message',
      })
    })
  })
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (e) {
    if (!isENOENT(e)) throw e
  }
}

/** Sockets left behind by sessions that crashed: nothing will ever answer them. */
async function sweepDeadSockets(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    logForDebugging(`[peers] could not list ${dir}: ${errorMessage(e)}`)
    return
  }
  for (const name of names) {
    const pid = Number(SOCKET_FILE_RE.exec(name)?.[1])
    if (!pid || pid === process.pid || isProcessRunning(pid)) continue
    await removeIfPresent(join(dir, name)).catch((e: unknown) =>
      logForDebugging(`[peers] could not sweep ${name}: ${errorMessage(e)}`),
    )
  }
}

/**
 * Bind this session's inbox. The path is keyed by PID, so a file already
 * there belongs to a dead process that reused it and is replaced.
 */
export async function startPeerInbox({
  handler,
  socketPath = socketPathFor(process.pid),
}: {
  handler: InboxHandler
  socketPath?: string
}): Promise<PeerInbox> {
  const dir = dirname(socketPath)
  await ensurePrivateSocketDir(dir)
  await removeIfPresent(socketPath)
  await sweepDeadSockets(dir)

  const token = randomBytes(32).toString('hex')
  const server = createServer(connection =>
    serveConnection(connection, token, handler),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(socketPath, 0o600)

  let closed = false
  const inbox: PeerInbox = {
    socketPath,
    token,
    async close() {
      if (closed) return
      closed = true
      if (ownInbox === inbox) ownInbox = undefined
      // Stop accepting without waiting for open connections to drain — one
      // can idle for 30s, and this runs inside the 2s exit cleanup budget.
      server.close()
      await removeIfPresent(socketPath)
    },
  }
  registerCleanup(() => inbox.close())
  ownInbox = inbox
  logForDebugging(`[peers] inbox bound at ${basename(socketPath)}`)
  return inbox
}
