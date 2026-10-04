import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { lazySchema } from 'src/shared/data/lazySchema.js'

const SCOPE_NAMES = [
  'local',
  'user',
  'project',
  'dynamic',
  'enterprise',
  'claudeai',
  'managed',
] as const

// `ws-ide` and `claudeai-proxy` are connection kinds, not user-facing
// transports, so they stay out of this list.
const TRANSPORT_NAMES = ['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk'] as const

const HTTPS_METADATA_ONLY = 'authServerMetadataUrl must use https://'

const stringRecord = () => z.record(z.string(), z.string())

/** The fields every remote transport shares: sse, http and ws. */
function remoteServerFields<Kind extends 'sse' | 'http' | 'ws'>(kind: Kind) {
  return {
    type: z.literal(kind),
    url: z.string(),
    headers: stringRecord().optional(),
    headersHelper: z.string().optional(),
  }
}

export const ConfigScopeSchema = lazySchema(() => z.enum(SCOPE_NAMES))
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>

export const TransportSchema = lazySchema(() => z.enum(TRANSPORT_NAMES))
export type Transport = z.infer<ReturnType<typeof TransportSchema>>

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1, { error: 'Command cannot be empty' }),
    args: z.array(z.string()).default(() => []),
    env: stringRecord().optional(),
  }),
)

const McpOAuthConfigSchema = lazySchema(() =>
  z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .url()
      .refine(url => url.startsWith('https://'), { error: HTTPS_METADATA_ONLY })
      .optional(),
  }),
)

export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    ...remoteServerFields('sse'),
    oauth: McpOAuthConfigSchema().optional(),
  }),
)

export const McpSSEIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string(),
    ideName: z.string(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

export const McpWebSocketIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

export const McpHTTPServerConfigSchema = lazySchema(() =>
  z.object({
    ...remoteServerFields('http'),
    oauth: McpOAuthConfigSchema().optional(),
  }),
)

// No oauth block: one given here is stripped like any unknown key.
export const McpWebSocketServerConfigSchema = lazySchema(() =>
  z.object(remoteServerFields('ws')),
)

export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)

export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)

// stdio is the only member whose `type` is optional, so an untyped entry is
// stdio or nothing: `{ command, url }` parses as stdio with the url stripped.
export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)

export type McpStdioServerConfig = z.infer<
  ReturnType<typeof McpStdioServerConfigSchema>
>
export type McpSSEServerConfig = z.infer<
  ReturnType<typeof McpSSEServerConfigSchema>
>
export type McpHTTPServerConfig = z.infer<
  ReturnType<typeof McpHTTPServerConfigSchema>
>
export type McpWebSocketServerConfig = z.infer<
  ReturnType<typeof McpWebSocketServerConfigSchema>
>
export type McpSdkServerConfig = z.infer<
  ReturnType<typeof McpSdkServerConfigSchema>
>
export type McpClaudeAIProxyServerConfig = z.infer<
  ReturnType<typeof McpClaudeAIProxyServerConfigSchema>
>
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string
}

export const McpJsonConfigSchema = lazySchema(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)

export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

export type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}

export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

export type DisabledMCPServer = {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}

export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer

export type ServerResource = Resource & { server: string }
