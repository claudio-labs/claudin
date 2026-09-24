import { createConnection } from 'net'
import { getErrnoCode } from 'src/shared/errors.js'
import {
  decodeResponse,
  encodeFrame,
  MAX_FRAME_BYTES,
  type RequestFrame,
  type ResponseFrame,
} from 'src/sessions/peers/frames.js'

const SEND_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 250

export class PeerDeliveryError extends Error {
  constructor(
    message: string,
    /** `gone`: nothing listens there any more. */
    readonly reason: 'gone' | 'timeout' | 'invalid',
  ) {
    super(message)
  }
}

/** Send one frame to a session's inbox and wait for its one-line answer. */
export function sendFrame(
  socketPath: string,
  frame: RequestFrame,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<ResponseFrame> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      outcome()
    }
    socket.setTimeout(timeoutMs, () =>
      settle(() =>
        reject(
          new PeerDeliveryError(
            `timed out after ${timeoutMs / 1000}s waiting for that session to answer`,
            'timeout',
          ),
        ),
      ),
    )
    socket.on('connect', () => socket.write(encodeFrame(frame)))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\n')
      if (end === -1) {
        if (buffer.length > MAX_FRAME_BYTES) {
          settle(() => reject(new PeerDeliveryError('oversized answer', 'invalid')))
        }
        return
      }
      const response = decodeResponse(buffer.slice(0, end))
      settle(() =>
        response
          ? resolve(response)
          : reject(new PeerDeliveryError('malformed answer', 'invalid')),
      )
    })
    socket.on('error', error => {
      const code = getErrnoCode(error)
      settle(() =>
        reject(
          code === 'ENOENT' || code === 'ECONNREFUSED'
            ? new PeerDeliveryError('no session is listening at that address any more', 'gone')
            : new PeerDeliveryError(error.message, 'invalid'),
        ),
      )
    })
    socket.on('close', () =>
      settle(() =>
        reject(new PeerDeliveryError('the session closed the connection without answering', 'gone')),
      ),
    )
  })
}

/**
 * Whether a listed session answers at all: its PID can be alive while its
 * inbox is gone (a crash between the two, a PID reused by another program).
 */
export async function pingInbox(socketPath: string, token: string): Promise<boolean> {
  try {
    const response = await sendFrame(
      socketPath,
      { v: 1, type: 'ping', msg_id: 'ping', token },
      PROBE_TIMEOUT_MS,
    )
    return response.ok
  } catch (e) {
    if (e instanceof PeerDeliveryError) return false
    throw e
  }
}
