/**
 * Node-side driver for WebSocketTransport.node.test.ts. It is bundled with
 * `Bun.build({ target: 'node' })` and run under `node`, because the
 * transport's Node branch (`typeof Bun === 'undefined'` → the real `ws`
 * package) cannot run inside `bun test`: there `import('ws')` resolves to
 * Bun's own shim, and the real package does not work on Bun's `node:http`.
 *
 * Scenario: a `ws` WebSocketServer confirms, through the `x-last-request-id`
 * header of its upgrade response, the first of three messages it received.
 * It then drops the connection; the transport reconnects, and the driver
 * records which messages arrive on the second connection. One JSON summary
 * line goes to stdout.
 */
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { StdoutMessage } from 'src/platform/entrypoints/sdk/controlTypes.js'
import { WebSocketTransport } from '../WebSocketTransport.js'

export type TransportNodeDriverResult = {
  runtime: string
  connections: number
  /** `x-last-request-id` the client sent on each upgrade request. */
  requestLastIds: Array<string | null>
  /** `x-last-request-id` the server put on each upgrade response. */
  responseLastIds: Array<string | null>
  /** uuids received on the first connection, in order. */
  firstConnection: string[]
  /** uuids received after the reconnect, in order. */
  afterReconnect: string[]
  error?: string
}

const CONFIRMED_ID = 'u1'
const SETTLE_MS = 300
const DEADLINE_MS = 8000

function msg(uuid: string): StdoutMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-node',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
  } as unknown as StdoutMessage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + DEADLINE_MS
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${label}`)
    await sleep(5)
  }
}

async function main(): Promise<TransportNodeDriverResult> {
  const received: string[][] = []
  const sockets: WsSocket[] = []
  const result: TransportNodeDriverResult = {
    runtime: typeof Bun === 'undefined' ? `node ${process.version}` : 'bun',
    connections: 0,
    requestLastIds: [],
    responseLastIds: [],
    firstConnection: [],
    afterReconnect: [],
  }

  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  server.on('headers', (headers: string[], req: IncomingMessage) => {
    const sent = req.headers['x-last-request-id']
    result.requestLastIds.push(typeof sent === 'string' ? sent : null)
    // From the second upgrade on, the server says it already has u1.
    if (result.requestLastIds.length > 1) {
      headers.push(`x-last-request-id: ${CONFIRMED_ID}`)
      result.responseLastIds.push(CONFIRMED_ID)
    } else {
      result.responseLastIds.push(null)
    }
  })
  server.on('connection', ws => {
    const lines: string[] = []
    received.push(lines)
    sockets.push(ws)
    result.connections++
    ws.on('message', data => {
      for (const line of data.toString().split('\n')) {
        if (line) lines.push((JSON.parse(line) as { uuid?: string }).uuid ?? '-')
      }
    })
  })

  const { port } = server.address() as { port: number }
  const transport = new WebSocketTransport(
    new URL(`ws://127.0.0.1:${port}/v1/session/node`),
    { Authorization: 'Bearer node' },
    'sess-node',
  )

  try {
    await transport.connect()
    await waitFor(() => transport.isConnectedStatus(), 'first open')
    await transport.write(msg('u1'))
    await transport.write(msg('u2'))
    await transport.write(msg('u3'))
    await waitFor(() => received[0]?.length === 3, 'three messages')

    sockets[0]!.close(1011, 'server restart')
    await waitFor(
      () => result.connections === 2 && transport.isConnectedStatus(),
      'reconnect',
    )
    await sleep(SETTLE_MS)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    transport.close()
    for (const ws of sockets) ws.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  result.firstConnection = received[0] ?? []
  result.afterReconnect = received[1] ?? []
  return result
}

main().then(
  result => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exit(0)
  },
  (error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })}\n`,
    )
    process.exit(1)
  },
)
