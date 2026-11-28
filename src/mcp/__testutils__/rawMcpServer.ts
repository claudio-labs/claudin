/**
 * A raw JSON-RPC MCP server on an in-memory transport, joined to a real v2
 * Client the way connectToServer joins one: through attachMcpWireFilter. Each
 * method answers with whatever its handler returns, unchecked, so a test can
 * send a page no SDK server would build; a handler that throws answers a
 * JSON-RPC error (a ProtocolError keeps its code).
 *
 * The config defaults to `sdk` so ensureConnectedClient hands the connection
 * straight back instead of reconnecting through connectToServer.
 */
import {
  Client,
  InMemoryTransport,
  type JSONRPCMessage,
  ProtocolError,
  type ServerCapabilities,
} from '@modelcontextprotocol/client'
import { attachMcpWireFilter } from 'src/mcp/client/wireFilter.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'

export type RawParams = Record<string, unknown> | undefined
export type RawHandler = (params: RawParams) => unknown

export type RawServerSpec = {
  capabilities: ServerCapabilities
  answers: Record<string, RawHandler>
  /** false connects the client bare, as the SDK alone would (a control). */
  wireFilter?: boolean
}

export type RawMcpServer = {
  connection: ConnectedMCPServer
  /** Every request the server got after initialize, in order. */
  requests: Array<{ method: string; params: RawParams }>
  close: () => Promise<void>
}

/** A handler that answers `result` for every request. */
export function always(result: unknown): RawHandler {
  return () => result
}

type Incoming = { id?: string | number; method?: string; params?: RawParams }

export async function connectRawMcpServer(
  name: string,
  spec: RawServerSpec,
  config: ScopedMcpServerConfig = { type: 'sdk', name, scope: 'local' } as ScopedMcpServerConfig,
): Promise<RawMcpServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const requests: RawMcpServer['requests'] = []
  const reply = (message: Record<string, unknown>) =>
    serverTransport.send({ jsonrpc: '2.0', ...message } as JSONRPCMessage)

  serverTransport.onmessage = async message => {
    const { id, method, params } = message as Incoming
    if (id === undefined || method === undefined) return
    if (method === 'initialize') {
      await reply({
        id,
        result: {
          protocolVersion: params?.protocolVersion,
          capabilities: spec.capabilities,
          serverInfo: { name: `${name}-raw`, version: '1.0.0' },
        },
      })
      return
    }
    requests.push({ method, params })
    const handler = spec.answers[method]
    if (!handler) {
      await reply({ id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      await reply({ id, result: await handler(params) })
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32603
      await reply({ id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
  await serverTransport.start()

  const client = new Client({ name: 'raw-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
  if (spec.wireFilter !== false) attachMcpWireFilter(name, clientTransport)
  await client.connect(clientTransport)

  const close = async () => {
    await client.close()
  }
  return {
    connection: {
      type: 'connected',
      name,
      client,
      capabilities: client.getServerCapabilities() ?? {},
      config,
      cleanup: close,
    },
    requests,
    close,
  }
}
