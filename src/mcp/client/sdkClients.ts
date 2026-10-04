import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Tool } from 'src/tools/Tool.js'
import { logMCPError } from 'src/shared/log.js'
import { SdkControlClientTransport } from 'src/mcp/SdkControlTransport.js'
import type { ConnectedMCPServer, McpSdkServerConfig, MCPServerConnection } from 'src/mcp/types.js'
import { mcpClientIdentity } from 'src/mcp/client/clientIdentity.js'
import { fetchToolsForClient } from 'src/mcp/client/fetchCapabilities.js'

type SdkServerSetup = { client: MCPServerConnection; tools: Tool[] }

async function connectSdkServer(
  name: string,
  config: McpSdkServerConfig,
  sendMcpMessage: (serverName: string, message: JSONRPCMessage) => Promise<JSONRPCMessage>,
): Promise<SdkServerSetup> {
  const client = new Client(mcpClientIdentity(), { capabilities: {} })
  try {
    await client.connect(new SdkControlClientTransport(name, sendMcpMessage))
  } catch (error) {
    logMCPError(name, error)
    await client.close().catch(() => {})
    return { client: { type: 'failed', name, config: { ...config, scope: 'user' } }, tools: [] }
  }
  const connection: ConnectedMCPServer = {
    type: 'connected',
    name,
    client,
    capabilities: client.getServerCapabilities() ?? {},
    serverInfo: client.getServerVersion(),
    instructions: client.getInstructions(),
    config: { ...config, scope: 'dynamic' },
    cleanup: () => client.close(),
  }
  return { client: connection, tools: await fetchToolsForClient(connection) }
}

export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: (
    serverName: string,
    message: JSONRPCMessage,
  ) => Promise<JSONRPCMessage>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
}> {
  const setups = await Promise.all(
    Object.entries(sdkMcpConfigs).map(([name, config]) => connectSdkServer(name, config, sendMcpMessage)),
  )
  return { clients: setups.map(s => s.client), tools: setups.flatMap(s => s.tools) }
}
