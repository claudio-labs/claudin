/**
 * Harnesses for driving connectToServer (src/mcp/client/connection.ts) without
 * a network: an in-process MCP server on a linked in-memory transport pair,
 * hand-built failing transports, and a raw JSON-RPC stdio server script for
 * the child-process paths.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import * as transportModule from 'src/mcp/client/transport.js'
import type { InProcessMcpServer } from 'src/mcp/client/transport.js'

export type InMemoryRemote = {
  server: Server
  /** The client half handed to connectToServer, with call counters. */
  clientTransport: InMemoryTransport
  closes: () => number
  /** Every JSON-RPC message the client sent, as it went on the wire. */
  sent: JSONRPCMessage[]
}

export function createInMemoryRemote(options: {
  capabilities?: ServerCapabilities
  instructions?: string
} = {}): InMemoryRemote {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new Server(
    { name: 'fixture', version: '9.9.9' },
    { capabilities: options.capabilities ?? { tools: {} }, instructions: options.instructions },
  )
  let closes = 0
  const linked = clientTransport as unknown as { _otherTransport?: unknown }
  const close = clientTransport.close.bind(clientTransport)
  // The pair closes each other, so the client half's close() re-enters once
  // the link is cut; only a close that found the link intact is counted.
  clientTransport.close = async () => {
    if (linked._otherTransport) closes++
    await close()
  }
  const sent: JSONRPCMessage[] = []
  const send = clientTransport.send.bind(clientTransport)
  clientTransport.send = async (message, options) => {
    sent.push(message)
    await send(message, options)
  }
  void server.connect(serverTransport)
  return { server, clientTransport, closes: () => closes, sent }
}

/** A transport whose start() fails with `error`; counts close() calls. */
export function failingTransport(error: unknown): Transport & { closes: () => number } {
  let closes = 0
  return {
    start: async () => {
      throw error
    },
    send: async () => {},
    close: async () => {
      closes++
    },
    closes: () => closes,
  }
}

/** A transport that accepts every message and never answers. */
export function silentTransport(): Transport & { closes: () => number } {
  let closes = 0
  return {
    start: async () => {},
    send: async () => {},
    close: async () => {
      closes++
    },
    closes: () => closes,
  }
}

export function fakeInProcessServer(options: { closeError?: Error } = {}): InProcessMcpServer & {
  closes: () => number
} {
  let closes = 0
  return {
    connect: async () => {},
    close: async () => {
      closes++
      if (options.closeError) throw options.closeError
    },
    closes: () => closes,
  }
}

/**
 * Replaces createTransport for the next connect(s). The caller restores the
 * returned spy (mockRestore) in its teardown.
 */
export function stubCreateTransport(
  make: () => { transport: Transport; inProcessServer?: InProcessMcpServer },
) {
  return spyOn(transportModule, 'createTransport').mockImplementation(async () => make())
}

// A newline-delimited JSON-RPC MCP server. Behaviour is chosen by env:
//   FIXTURE_STDERR          written to stderr at startup
//   FIXTURE_EXIT_EARLY=1    exits with code 3 before answering anything
//   FIXTURE_IGNORE          comma list of signals to ignore (INT, TERM)
// It exits when stdin closes, which is how StdioClientTransport.close() ends it.
const STDIO_SERVER_SOURCE = `
const ignore = (process.env.FIXTURE_IGNORE || '').split(',').filter(Boolean)
for (const sig of ignore) process.on('SIG' + sig, () => {})
if (process.env.FIXTURE_STDERR) process.stderr.write(process.env.FIXTURE_STDERR)
if (process.env.FIXTURE_EXIT_EARLY === '1') {
  setTimeout(() => process.exit(3), 10)
} else {
  let buf = ''
  process.stdin.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
          },
        }) + '\\n')
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
`

export type StdioFixture = { command: string; args: string[]; dispose: () => void }

export function writeStdioServer(): StdioFixture {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-conn-stdio-'))
  const script = join(dir, 'server.js')
  writeFileSync(script, STDIO_SERVER_SOURCE)
  return {
    command: process.execPath,
    args: [script],
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
