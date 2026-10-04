/**
 * The fixes the clean-base rewrite of `mcp/connection` made (spec Findings 4,
 * 5, 6 and 9), each driven through the real code: a stdio server the client
 * spawns, a WebSocket server on loopback, and, where a failure has to be
 * produced on demand, a transport handed in through `openConnection`'s deps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { clearServerCache, connectToServer, getServerCacheKey } from 'src/mcp/client.js'
import { useIsolatedStore } from 'src/mcp/auth/__testutils__/oauthTestBed.js'
import {
  isAlive,
  serveWs,
  type StdioBed,
  until,
  useBuildMacro,
  writeStdioServer,
} from 'src/mcp/client/__testutils__/mcpServerBed.js'
import { createMcpClient } from 'src/mcp/client/connection/handshake.js'
import { defaultOpenConnectionDeps, openConnection } from 'src/mcp/client/connection/openConnection.js'
import { WebSocketTransport } from 'src/mcp/mcpWebSocketTransport.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js'

useBuildMacro()
const store = useIsolatedStore()

let stdio: StdioBed
let serial = 0
const stops: Array<() => unknown> = []
const live: MCPServerConnection[] = []

beforeEach(() => {
  stdio = writeStdioServer(store.root(), 'fixes-stdio.log')
})

afterEach(async () => {
  for (const conn of live.splice(0)) {
    if (conn.type === 'connected') await conn.cleanup().catch(() => {})
    await clearServerCache(conn.name, conn.config)
  }
  for (const stop of stops.splice(0)) await stop()
  for (const pid of stdio.pids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
})

const fresh = (stem: string) => `fix-${stem}-${++serial}-${process.pid}`

/** A transport whose start fails, so the SDK never gets to close it itself. */
function refusingTransport() {
  const state = { closed: 0 }
  const transport: Transport = {
    start: async () => {
      throw new Error('refused at start')
    },
    send: async () => {},
    close: async () => {
      state.closed += 1
    },
  }
  return { transport, state }
}

describe('Finding 4: a failed connection closes its transport, whatever its type', () => {
  test('every remote type, the three that used to stay open included', async () => {
    const configs: ScopedMcpServerConfig[] = [
      { type: 'http', url: 'http://127.0.0.1:1/mcp', scope: 'user' },
      { type: 'sse', url: 'http://127.0.0.1:1/sse', scope: 'user' },
      { type: 'claudeai-proxy', url: 'https://ignored.example', id: 'srv_1', scope: 'claudeai' },
      { type: 'ws', url: 'ws://127.0.0.1:1/', scope: 'user' },
      { type: 'sse-ide', url: 'http://127.0.0.1:1/sse', ideName: 'Editor', scope: 'dynamic' },
    ]
    for (const config of configs) {
      const { transport, state } = refusingTransport()
      const name = fresh('failed')
      const record = await openConnection(name, config, () => {}, {
        ...defaultOpenConnectionDeps,
        createTransport: async () => ({ transport }),
      })
      expect({ type: config.type, record, closed: state.closed }).toEqual({
        type: config.type,
        record: { name, type: 'failed', config, error: 'refused at start' },
        closed: 1,
      })
    }
  })

  test('a stdio child that never answers is signalled to stop, not only cut off from stdin', async () => {
    const saved = process.env.MCP_TIMEOUT
    process.env.MCP_TIMEOUT = '300'
    try {
      const name = fresh('silent')
      const record = await connectToServer(name, stdio.config({ BED_SILENT: '1', BED_TRAP: 'SIGINT' }))
      live.push(record)
      expect(record.type).toBe('failed')
      const [pid] = stdio.pids()
      await until(() => isAlive(pid!), alive => !alive, 'the child to stop')
      const signals = stdio.events().filter(e => e.event === 'signal').map(e => e.name)
      expect(signals).toEqual(['SIGINT'])
    } finally {
      if (saved === undefined) delete process.env.MCP_TIMEOUT
      else process.env.MCP_TIMEOUT = saved
    }
  })

  test('the in-process server of a failed connection is closed before its transport', async () => {
    const order: string[] = []
    const { transport } = refusingTransport()
    const closingTransport: Transport = { ...transport, close: async () => void order.push('transport') }
    await openConnection(fresh('in-process'), { type: 'http', url: 'http://127.0.0.1:1/', scope: 'user' }, () => {}, {
      ...defaultOpenConnectionDeps,
      createTransport: async () => ({
        transport: closingTransport,
        inProcessServer: { connect: async () => {}, close: async () => void order.push('server') },
      }),
    })
    expect(order).toEqual(['server', 'transport'])
  })
})

describe('Finding 5: a stdio cleanup always closes the client', () => {
  test('when the process is already gone, and when stopping it fails', async () => {
    const cases: Array<{ label: string; killFirst: boolean; stopperFails: boolean }> = [
      { label: 'process already gone', killFirst: true, stopperFails: false },
      { label: 'stopper throws', killFirst: false, stopperFails: true },
    ]
    for (const { label, killFirst, stopperFails } of cases) {
      let closes = 0
      const before = stdio.pids().length
      const record = await openConnection(fresh('stdio-cleanup'), stdio.config(), () => {}, {
        ...defaultOpenConnectionDeps,
        createClient: () => {
          const client = createMcpClient()
          const close = client.close.bind(client)
          client.close = async () => {
            closes += 1
            await close()
          }
          return client
        },
        stopProcess: stopperFails
          ? async () => {
              throw new Error('cannot signal')
            }
          : defaultOpenConnectionDeps.stopProcess,
      })
      expect(record.type).toBe('connected')
      if (record.type !== 'connected') continue
      live.push(record)
      const pid = stdio.pids()[before]!
      if (killFirst) {
        process.kill(pid, 'SIGKILL')
        await until(() => isAlive(pid), alive => !alive, 'the process to die')
      }
      await record.cleanup().catch(() => {})
      expect({ label, closes }).toEqual({ label, closes: 1 })
    }
  })
})

describe('Finding 6: clearServerCache never opens a connection to close it', () => {
  test('a server that was never connected', async () => {
    const name = fresh('never')
    const config = stdio.config()
    await clearServerCache(name, config)
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
    await Bun.sleep(50)
    expect(stdio.pids()).toEqual([])
  })

  test('a server whose record was forgotten when its process died', async () => {
    const name = fresh('forgotten')
    const config = stdio.config()
    const first = await connectToServer(name, config)
    live.push(first)
    expect(first.type).toBe('connected')
    const [pid] = stdio.pids()
    process.kill(pid!, 'SIGKILL')
    const key = getServerCacheKey(name, config)
    await until(() => connectToServer.cache.has(key), cached => !cached, 'the record to be forgotten')
    await clearServerCache(name, config)
    await Bun.sleep(50)
    expect(stdio.pids()).toHaveLength(1)
    expect(connectToServer.cache.has(key)).toBe(false)
  })
})

describe('Finding 9: the WebSocket transport fires onclose once', () => {
  async function started() {
    const server = serveWs({ tools: [] })
    stops.push(server.stop)
    const transport = new WebSocketTransport(new WebSocket(server.url, ['mcp']))
    const counter = { closes: 0 }
    transport.onclose = () => void (counter.closes += 1)
    await transport.start()
    await until(() => server.seen.length, n => n > 0, 'the upgrade')
    return { server, transport, counter }
  }

  test('close() on an open socket', async () => {
    const { transport, counter } = await started()
    await transport.close()
    await Bun.sleep(50)
    expect(counter.closes).toBe(1)
  })

  test('close() after the server hung up', async () => {
    const { server, transport, counter } = await started()
    await Bun.sleep(20)
    server.hangUp()
    await until(() => counter.closes, n => n > 0, 'onclose')
    await transport.close()
    await Bun.sleep(50)
    expect(counter.closes).toBe(1)
  })
})
