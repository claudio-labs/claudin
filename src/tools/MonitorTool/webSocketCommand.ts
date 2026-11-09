// Monitor's `ws` source: a WebSocket that behaves like the shell command a
// monitor would otherwise run. Each incoming frame is appended to the task's
// output file as lines, so monitorStream, TaskStop and `timeout_ms` treat it
// exactly as they treat `tail -f`. The socket's own lifecycle — a refused
// upgrade, an error, the close — lands in the same file as a bracketed line,
// which makes the close the last event the model sees before the exit notice.

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { generateTaskId } from 'src/agent/Task.js'
import { appendTaskOutput, evictTaskOutput } from 'src/agent/tasks/diskOutput.js'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { isBlockedAddress } from 'src/platform/lifecycleHooks/ssrfGuard.js'
import { openWebSocket, type WebSocketHandle } from 'src/providers/transport/webSocket.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { ExecResult, ShellCommand } from 'src/shared/proc/ShellCommand.js'

export const WS_MAX_FRAME_BYTES = 1024 * 1024

// Printable ASCII only: no whitespace, no control characters.
const WS_URL_RE = /^wss?:\/\/[\x21-\x7e]+$/
// An RFC 6455 subprotocol is an RFC 7230 token.
const SUBPROTOCOL_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const IPV6_BRACKETS_RE = /^\[|\]$/g
const TRAILING_BREAK_RE = /\n$/

// What the exit notice reports: a normal close reads "stream ended", anything
// else "failed"; a stopped monitor is `killed` whatever its code.
const EXIT_CLOSED = 0
const EXIT_ABNORMAL = 1
const EXIT_STOPPED = 143
const CLOSE_NORMAL = 1000
const CLOSE_TOO_BIG = 1009

export type MonitorWsInput = { url: string; protocols?: string[] }

/** Why `ws` cannot be opened as given, or null. Checks the shape only — no network. */
export function wsInputError(ws: MonitorWsInput): string | null {
  if (!WS_URL_RE.test(ws.url)) return 'ws.url must be a ws:// or wss:// URL written in printable ASCII'
  let url: URL
  try {
    url = new URL(ws.url)
  } catch {
    return `ws.url is not a valid URL: ${ws.url}`
  }
  if (url.username || url.password) return 'ws.url must not carry credentials (user:password@)'
  const protocols = ws.protocols ?? []
  const bad = protocols.find(p => !SUBPROTOCOL_RE.test(p))
  if (bad !== undefined) return `ws.protocols entry "${bad}" is not a valid subprotocol token`
  if (new Set(protocols).size !== protocols.length) return 'ws.protocols lists an entry twice'
  return null
}

export type ResolveHost = (host: string) => Promise<string[]>

const resolveHost: ResolveHost = async host => (await dnsLookup(host, { all: true })).map(a => a.address)

/**
 * Why the URL's host must not be reached, or null. The ranges are the HTTP
 * hooks' (`isBlockedAddress`): private, link-local and cloud-metadata
 * addresses are refused, loopback is allowed. Every resolved address counts,
 * so a name with one private record is refused.
 */
export async function wsTargetRefusal(rawUrl: string, resolve: ResolveHost = resolveHost): Promise<string | null> {
  const host = new URL(rawUrl).hostname.replace(IPV6_BRACKETS_RE, '')
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await resolve(host)
    } catch (e) {
      return `could not resolve ${host}: ${errorMessage(e)}`
    }
  }
  if (addresses.length === 0) return `could not resolve ${host}`
  const blocked = addresses.find(isBlockedAddress)
  if (blocked === undefined) return null
  return blocked === host
    ? `${host} is in a private, link-local or cloud-metadata range`
    : `${host} resolves to ${blocked}, which is in a private, link-local or cloud-metadata range`
}

export type WebSocketCommandDeps = {
  open?: typeof openWebSocket
  append?: (taskId: string, text: string) => void
  /** Settles once everything appended is on disk. */
  flush?: (taskId: string) => Promise<void>
}

/** A ShellCommand whose "process" is the socket: it ends when the socket closes. */
export function createWebSocketCommand(ws: MonitorWsInput, deps: WebSocketCommandDeps = {}): ShellCommand {
  const open = deps.open ?? openWebSocket
  const append = deps.append ?? appendTaskOutput
  const flush = deps.flush ?? evictTaskOutput
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null, true)
  const taskId = taskOutput.taskId

  let status: ShellCommand['status'] = 'running'
  let refused = false
  let finished = false
  let settle: (result: ExecResult) => void = () => {}
  const result = new Promise<ExecResult>(resolve => {
    settle = resolve
  })

  const line = (text: string): void => append(taskId, TRAILING_BREAK_RE.test(text) ? text : `${text}\n`)

  const finish = (code: number): void => {
    if (finished) return
    finished = true
    if (status !== 'killed') status = 'completed'
    void flush(taskId)
      .catch(logError)
      .finally(() => settle({ code, stdout: '', stderr: '', interrupted: status === 'killed' }))
  }

  const close = (code: number, reason: string): void => {
    try {
      socket.close(code, reason)
    } catch (e) {
      logError(e)
    }
  }

  const socket: WebSocketHandle = open(ws.url, {
    ...(ws.protocols?.length ? { protocols: ws.protocols } : {}),
    handlers: {
      onMessage(data, isBinary) {
        const bytes = Buffer.byteLength(data)
        if (bytes > WS_MAX_FRAME_BYTES) {
          line(`[Dropped a ${bytes}-byte frame (over ${WS_MAX_FRAME_BYTES} bytes); closing]`)
          close(CLOSE_TOO_BIG, 'frame too large')
          return
        }
        line(isBinary ? `[binary frame, ${bytes} bytes]` : data)
      },
      onRefused(httpStatus) {
        refused = true
        line(`[WebSocket upgrade rejected: HTTP ${httpStatus}]`)
      },
      onError(error) {
        // A refused upgrade also reports an error; the refusal already said it.
        if (!refused) line(`[WebSocket error: ${error.message}]`)
      },
      onClose(code, reason) {
        line(`[WebSocket closed: ${code}${reason ? ` ${reason}` : ''}]`)
        finish(code === CLOSE_NORMAL && !refused ? EXIT_CLOSED : EXIT_ABNORMAL)
      },
    },
  })

  return {
    taskOutput,
    result,
    get status() {
      return status
    },
    background() {
      if (status === 'running') status = 'backgrounded'
      return true
    },
    // killTask calls kill() then cleanup() at once, so the result settles here
    // rather than waiting for a close event the detach would drop.
    kill() {
      if (finished) return
      status = 'killed'
      close(CLOSE_NORMAL, 'monitor stopped')
      finish(EXIT_STOPPED)
    },
    cleanup() {
      socket.detach()
    },
  }
}
