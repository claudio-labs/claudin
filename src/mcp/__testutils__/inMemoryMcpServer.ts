import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type ServerNotification,
  type ServerRequest,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { attachMcpWireFilter } from 'src/mcp/client/fetchCapabilities.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

export type InMemoryServerSpec = {
  tools?: McpTool[]
  callTool?: (
    name: string,
    args: Record<string, unknown> | undefined,
    extra: Extra & { requestMeta?: Record<string, unknown> },
  ) => Promise<CallToolResult> | CallToolResult
  prompts?: Prompt[]
  getPrompt?: (
    name: string,
    args: Record<string, string> | undefined,
  ) => Promise<GetPromptResult> | GetPromptResult
  resources?: Resource[]
  /** Omit to leave resources/templates/list unhandled (MethodNotFound). */
  resourceTemplates?: ResourceTemplate[] | (() => never)
}

export type InMemoryMcpServer = {
  connection: ConnectedMCPServer
  close: () => Promise<void>
}

/**
 * A real v1 SDK Server (a legacy fixture) and the v2 Client joined by InMemoryTransport, wrapped in the
 * ConnectedMCPServer shape the fetchers take, through the wire filter
 * connectToServer attaches. The config defaults to `sdk` so
 * ensureConnectedClient hands the connection straight back instead of
 * reconnecting through connectToServer.
 */
export async function connectInMemoryMcpServer(
  name: string,
  spec: InMemoryServerSpec,
  config: ScopedMcpServerConfig = { type: 'sdk', name, scope: 'local' } as ScopedMcpServerConfig,
): Promise<InMemoryMcpServer> {
  const capabilities: ServerCapabilities = {
    ...(spec.tools && { tools: {} }),
    ...(spec.prompts && { prompts: {} }),
    ...(spec.resources && { resources: {} }),
  }
  const server = new Server({ name: `${name}-server`, version: '1.0.0' }, { capabilities })

  if (spec.tools) {
    const tools = spec.tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      if (!spec.callTool) return { content: [] }
      return spec.callTool(req.params.name, req.params.arguments, {
        ...extra,
        requestMeta: req.params._meta as Record<string, unknown> | undefined,
      })
    })
  }
  if (spec.prompts) {
    const prompts = spec.prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }))
    server.setRequestHandler(GetPromptRequestSchema, async req =>
      spec.getPrompt
        ? spec.getPrompt(req.params.name, req.params.arguments)
        : { messages: [] },
    )
  }
  if (spec.resources) {
    const resources = spec.resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }))
    const templates = spec.resourceTemplates
    if (templates) {
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
        typeof templates === 'function' ? templates() : { resourceTemplates: templates },
      )
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'cover-client', version: '1.0.0' })
  await server.connect(serverTransport)
  attachMcpWireFilter(name, clientTransport)
  await client.connect(clientTransport)

  const close = async () => {
    await client.close()
    await server.close()
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
    close,
  }
}
