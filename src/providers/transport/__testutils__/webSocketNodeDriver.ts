/**
 * Runs openWebSocket's Node branch under node with the real `ws` package and
 * prints what it saw as one JSON line. webSocket.node.test.ts bundles this
 * file for node and runs it: inside `bun test`, `ws` is Bun's shim, which
 * emits neither `upgrade` nor `unexpected-response`.
 */
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createNetServer, type Socket } from 'node:net'
import WS, { WebSocketServer } from 'ws'
import { openWebSocket, type WebSocketHandle } from 'src/providers/transport/webSocket.js'

type Report = Record<string, unknown>

function listen(server: { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

async function roundTrip(report: Report): Promise<void> {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http, handleProtocols: protocols => [...protocols][0] ?? false })
  wss.on('headers', headers => headers.push('X-Last-Request-Id: abc'))
  wss.on('connection', (socket, req) => {
    report.serverAuthorization = req.headers.authorization
    report.serverProtocol = socket.protocol
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString()
      if (text === 'echo') socket.send('echo:ok')
      else if (text === 'bytes') socket.send(Buffer.from([1, 2, 3]))
      else if (text === 'bye') socket.close(4001, 'bye now')
      else if (isBinary) report.serverBytes = [...(data as Buffer)]
    })
  })
  const port = await listen(http)
  const events: string[] = []
  const done = new Promise<void>(resolve => {
    let handle: WebSocketHandle
    const bytes: number[][] = []
    handle = openWebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { authorization: 'Bearer t0k' },
      protocols: ['mcp'],
      handlers: {
        onUpgrade: headers => {
          events.push('upgrade')
          report.upgradeLastId = headers['x-last-request-id']
        },
        onOpen: () => {
          events.push('open')
          void handle.send('echo').then(() => events.push('sent'))
        },
        onMessage: data => {
          events.push(`message:${data}`)
          handle.listen({
            onBinary: b => {
              bytes.push([...b])
              report.clientBytes = bytes
              handle.ping()
            },
            onPong: () => {
              events.push('pong')
              void handle.send(new Uint8Array([9, 8])).then(() => handle.send('bye'))
            },
            onClose: (code, reason) => {
              events.push(`close:${code}:${reason}`)
              resolve()
            },
          })
          void handle.send('bytes')
        },
      },
    })
  })
  await done
  report.roundTripEvents = events
  wss.close()
  http.close()
}

async function refused(report: Report): Promise<void> {
  const http = createHttpServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('go away')
  })
  const port = await listen(http)
  const events: string[] = []
  await new Promise<void>(resolve => {
    openWebSocket(`ws://127.0.0.1:${port}/`, {
      handlers: {
        onOpen: () => events.push('open'),
        onError: e => events.push(`error:${e.message}`),
        onRefused: (status, body) => events.push(`refused:${status}:${body}`),
        onClose: code => {
          events.push(`close:${code}`)
          resolve()
        },
      },
    })
  })
  report.refusedEvents = events
  http.close()
}

async function detach(report: Report): Promise<void> {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', socket => socket.on('message', () => socket.send('late')))
  const port = await listen(http)
  const events: string[] = []
  let instance: WS | undefined
  class Recording extends WS {
    constructor(...args: ConstructorParameters<typeof WS>) {
      super(...args)
      instance = this
    }
  }
  const watched = ['open', 'upgrade', 'message', 'error', 'close', 'pong', 'unexpected-response']
  const handle = openWebSocket(`ws://127.0.0.1:${port}/`, {
    handlers: {
      onOpen: () => {
        events.push('open')
        report.listenersBeforeDetach = watched.map(e => instance?.listenerCount(e) ?? -1)
        handle.detach()
        report.listenersAfterDetach = watched.map(e => instance?.listenerCount(e) ?? -1)
        void handle.send('ping-me')
      },
      onMessage: data => events.push(`message:${data}`),
      onClose: () => events.push('close'),
    },
  }, { loadWs: async () => Recording as unknown as typeof WS })
  await new Promise(resolve => setTimeout(resolve, 300))
  handle.close()
  await new Promise(resolve => setTimeout(resolve, 100))
  report.detachEvents = events
  wss.close()
  http.close()
}

async function proxied(report: Report): Promise<void> {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', socket => socket.send('hello'))
  const port = await listen(http)
  const connects: string[] = []
  const sockets: Socket[] = []
  const proxy = createNetServer(client => {
    sockets.push(client)
    client.once('data', chunk => {
      const target = chunk.toString('latin1').match(/^CONNECT ([^ ]+) HTTP/)?.[1]
      if (!target) return void client.destroy()
      connects.push(target)
      const [host, targetPort] = target.split(':')
      const upstream = connect(Number(targetPort), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
      sockets.push(upstream)
    })
  })
  const proxyPort = await listen(proxy)
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`
  delete process.env.NO_PROXY
  delete process.env.no_proxy
  const message = await new Promise<string>(resolve => {
    const handle = openWebSocket(`ws://127.0.0.1:${port}/`, {
      handlers: {
        onMessage: data => {
          handle.close()
          resolve(data)
        },
      },
    })
  })
  delete process.env.HTTPS_PROXY
  report.proxyConnects = connects
  report.proxiedMessage = message
  for (const s of sockets) s.destroy()
  proxy.close()
  wss.close()
  http.close()
}

const settleWithin = (ms: number, done: Promise<void>): Promise<void> =>
  Promise.race([done, new Promise<void>(resolve => setTimeout(resolve, ms))])

/** A URL ws's constructor rejects: it must end in an error and a close, not hang. */
async function fragment(report: Report): Promise<void> {
  const unhandled: string[] = []
  const onUnhandled = (e: unknown): void => void unhandled.push(e instanceof Error ? e.message : String(e))
  process.on('unhandledRejection', onUnhandled)
  const events: string[] = []
  await settleWithin(1000, new Promise<void>(resolve => {
    openWebSocket('ws://127.0.0.1:9/feed#x', {
      handlers: {
        onError: e => events.push(`error:${e.message}`),
        onClose: code => {
          events.push(`close:${code}`)
          resolve()
        },
      },
    })
  }))
  await new Promise(resolve => setTimeout(resolve, 50))
  process.off('unhandledRejection', onUnhandled)
  report.fragmentEvents = events
  report.fragmentUnhandled = unhandled
}

/** close() then detach() while the upgrade is pending: ws emits an error on the next tick. */
async function stopWhileConnecting(report: Report): Promise<void> {
  const held: Socket[] = []
  const silent = createNetServer(socket => held.push(socket))
  const port = await listen(silent)
  const uncaught: string[] = []
  const onUncaught = (e: Error): void => void uncaught.push(e.message)
  process.on('uncaughtException', onUncaught)
  const handle = openWebSocket(`ws://127.0.0.1:${port}/`, {})
  await new Promise(resolve => setTimeout(resolve, 200))
  handle.close(1000, 'stop')
  handle.detach()
  await new Promise(resolve => setTimeout(resolve, 200))
  process.off('uncaughtException', onUncaught)
  report.stopWhileConnectingUncaught = uncaught
  for (const s of held) s.destroy()
  silent.close()
}

/** `lookup` resolves the host for the connection, so its refusal is the socket's end. */
async function lookup(report: Report): Promise<void> {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })
  const port = await listen(http)
  const asked: string[] = []
  const events: string[] = []
  await settleWithin(1000, new Promise<void>(resolve => {
    openWebSocket(`ws://localhost:${port}/`, {
      lookup: (hostname, _options, callback) => {
        asked.push(hostname)
        callback(new Error(`refused ${hostname}`), '', 4)
      },
      handlers: {
        onOpen: () => events.push('open'),
        onError: e => events.push(`error:${e.message}`),
        onClose: code => {
          events.push(`close:${code}`)
          resolve()
        },
      },
    })
  }))
  report.lookupAsked = asked
  report.lookupEvents = events
  wss.close()
  http.close()
}

const report: Report = {}
const watchdog = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ...report, timedOut: true })}\n`)
  process.exit(1)
}, 15_000)
await roundTrip(report)
await refused(report)
await detach(report)
await proxied(report)
await fragment(report)
await stopWhileConnecting(report)
await lookup(report)
clearTimeout(watchdog)
process.stdout.write(`${JSON.stringify(report)}\n`)
process.exit(0)
