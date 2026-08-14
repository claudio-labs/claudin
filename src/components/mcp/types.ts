// Reconstructed from its use sites — the original module was not carried into
// this fork. The `*ServerInfo` shapes come from the four literals built in
// `commands/plugin/ManagePlugins.tsx`, `AgentMcpServerInfo` from the pushes in
// `services/mcp/utils.ts::extractAgentMcpServers`, and `MCPViewState` from the
// `setViewState` calls in `MCPSettings.tsx`.
import type {
  ConfigScope,
  MCPServerConnection,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from 'src/services/mcp/types.js'

type BaseServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
}

export type StdioServerInfo = BaseServerInfo & {
  transport: 'stdio'
  config: McpStdioServerConfig
}

export type SSEServerInfo = BaseServerInfo & {
  transport: 'sse'
  /** `undefined` until an auth probe has run. */
  isAuthenticated: boolean | undefined
  config: McpSSEServerConfig
}

export type HTTPServerInfo = BaseServerInfo & {
  transport: 'http'
  isAuthenticated: boolean | undefined
  config: McpHTTPServerConfig
}

export type ClaudeAIServerInfo = BaseServerInfo & {
  transport: 'claudeai-proxy'
  isAuthenticated: boolean | undefined
  config: McpClaudeAIProxyServerConfig
}

/** A configured MCP server as the `/mcp` panels display it. */
export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

/**
 * An MCP server declared inline by one or more agents rather than by settings.
 * `extractAgentMcpServers` only emits these four transports.
 */
export type AgentMcpServerInfo = {
  name: string
  /** `agentType` of every agent that declares this server. */
  sourceAgents: string[]
  needsAuth: boolean
  /** `undefined` until an auth probe has run. */
  isAuthenticated?: boolean
} & (
  | { transport: 'stdio'; command: string; url?: undefined }
  | { transport: 'sse' | 'http' | 'ws'; url: string; command?: undefined }
)

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
