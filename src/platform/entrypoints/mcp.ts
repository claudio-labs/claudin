// Claudin: the experimental-betas switch is on by default — see the matching
// comment in cli.tsx for what it still guards and where the adopted betas went.
// Opt in with CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=false.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS ??= 'true'

import {
  type CallToolResult,
  type ListToolsResult,
  Server,
  type Tool,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ZodError } from 'zod/v4'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import review from 'src/commands/review.js'
import type { Command } from 'src/commands/commands.js'
import { getMcpToolsCommandsAndResources } from 'src/mcp/client.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type Tool as InternalTool,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { getTools } from 'src/tools/tools.js'
import { createAbortController } from 'src/shared/abortController.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import { logError } from 'src/shared/log.js'
import { createAssistantMessage } from 'src/agent/messages/messages.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { getErrorParts } from 'src/agent/tools/toolErrors.js'
import { stripPlaceholderOptionalFields } from 'src/agent/tools/toolInputPlaceholders.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'

type ToolInput = Tool['inputSchema']
type ToolOutput = Tool['outputSchema']

const MCP_COMMANDS: Command[] = [review]

export function getCombinedTools(
  builtins: readonly InternalTool[],
  mcpTools: InternalTool[],
): InternalTool[] {
  const mcpToolNames = new Set(mcpTools.map(t => t.name))
  const deduplicatedBuiltins = builtins.filter(t => !mcpToolNames.has(t.name))

  return [...mcpTools, ...deduplicatedBuiltins]
}

export async function loadReexposedMcpTools(): Promise<{
  mcpClients: MCPServerConnection[]
  mcpTools: InternalTool[]
}> {
  const mcpClients: MCPServerConnection[] = []
  const mcpTools: InternalTool[] = []

  // Load configured MCP clients and their tools
  await getMcpToolsCommandsAndResources(({ client, tools: clientTools }) => {
    mcpClients.push(client)
    mcpTools.push(...clientTools)
  })

  return { mcpClients, mcpTools }
}

// What tools/list answers. A schema zod has no JSON Schema form for (the
// workflow tools' z.custom outputs) used to throw out of the handler and fail
// the list for every tool: an output schema that cannot be converted is left
// off its tool, and a tool whose input schema cannot be converted is left out.
export async function listToolsForMcpServe(
  tools: readonly InternalTool[],
  toolPermissionContext: ReturnType<typeof getEmptyToolPermissionContext>,
): Promise<ListToolsResult['tools']> {
  const listed = await Promise.all(
    tools.map(async (tool): Promise<Tool | null> => {
      let inputSchema: ToolInput
      try {
        inputSchema = (tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)) as ToolInput
      } catch (error) {
        logForDebugging(`[mcp serve] ${tool.name} left out of tools/list: ${errorMessage(error)}`)
        return null
      }
      let outputSchema: ToolOutput | undefined
      if (tool.outputSchema) {
        let convertedSchema: unknown
        try {
          convertedSchema = zodToJsonSchema(tool.outputSchema)
        } catch (error) {
          logForDebugging(`[mcp serve] ${tool.name} listed without its output schema: ${errorMessage(error)}`)
        }
        // MCP SDK requires outputSchema to have type: "object" at root level
        // Skip schemas with anyOf/oneOf at root (from z.union, z.discriminatedUnion, etc.)
        // See: https://github.com/anthropics/claude-code/issues/8014
        if (
          typeof convertedSchema === 'object' &&
          convertedSchema !== null &&
          'type' in convertedSchema &&
          convertedSchema.type === 'object'
        ) {
          outputSchema = convertedSchema as ToolOutput
        }
      }
      return {
        ...tool,
        description: await tool.prompt({
          getToolPermissionContext: async () => toolPermissionContext,
          tools,
          agents: [],
        }),
        inputSchema,
        outputSchema,
      }
    }),
  )
  return listed.filter((tool): tool is Tool => tool !== null)
}

export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // Use size-limited LRU cache for readFileState to prevent unbounded memory growth
  const readFileStateCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  setCwd(cwd)
  const { mcpClients, mcpTools } = await loadReexposedMcpTools()

  // One server per connection, built by serveStdio for the era the client
  // opens with: a 2025-era client gets the initialize handshake it always
  // got, a 2026-07-28 one gets server/discover.
  const createServer = (): Server => {
    const server = new Server(
      {
        // Upstream sent `claude/<codename>` here — its internal codename, announced to
        // every MCP client that connects to `claudin mcp serve`. This fork does
        // not present itself as upstream, and `serverInfo.name` is informational
        // in MCP (clients route on the transport, not on this string).
        name: 'claudin',
        version: MACRO.VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    )

    server.setRequestHandler(
      'tools/list',
      async (): Promise<ListToolsResult> => {
        const toolPermissionContext = getEmptyToolPermissionContext()
        const tools = getCombinedTools(getTools(toolPermissionContext), mcpTools)
        return { tools: await listToolsForMcpServe(tools, toolPermissionContext) }
      },
    )

    server.setRequestHandler(
      'tools/call',
      async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
        const toolPermissionContext = getEmptyToolPermissionContext()
        const tools = getCombinedTools(getTools(toolPermissionContext), mcpTools)
        const tool = findToolByName(tools, name)
        if (!tool) {
          throw new Error(`Tool ${name} not found`)
        }

        // Assume MCP servers do not read messages separately from the tool
        // call arguments.
        const toolUseContext: ToolUseContext = {
          abortController: createAbortController(),
          options: {
            commands: MCP_COMMANDS,
            tools,
            mainLoopModel: getMainLoopModel(),
            thinkingConfig: { type: 'disabled' },
            mcpClients,
            mcpResources: {},
            isNonInteractiveSession: true,
            debug,
            verbose,
            agentDefinitions: { activeAgents: [], allAgents: [] },
          },
          getAppState: () => getDefaultAppState(),
          setAppState: () => {},
          messages: [],
          readFileState: readFileStateCache,
          setInProgressToolUseIDs: () => {},
          setResponseLength: () => {},
          updateFileHistoryState: () => {},
          updateAttributionState: () => {},
        }

        try {
          if (!tool.isEnabled()) {
            throw new Error(`Tool ${name} is not enabled`)
          }

          // Validate input types with zod. Clients driving us through a
          // strict-schema model send "" / null for optional args they mean to
          // leave out — same normalization the in-process tool loop applies.
          const parsedArgs = tool.inputSchema.parse(
            stripPlaceholderOptionalFields(tool, args ?? {}),
          )
          // The same resolution the in-process tool loop applies (Tool.resolveInput).
          const resolved = tool.resolveInput
            ? await tool.resolveInput(parsedArgs as never, toolUseContext)
            : ({ ok: true, input: parsedArgs } as const)
          if (!resolved.ok) {
            throw new Error(`Tool ${name} input is invalid: ${resolved.message}`)
          }
          const toolArgs = resolved.input

          const validationResult = await tool.validateInput?.(
            (toolArgs as never) ?? {},
            toolUseContext,
          )
          if (validationResult && !validationResult.result) {
            throw new Error(
              `Tool ${name} input is invalid: ${validationResult.message}`,
            )
          }
          const finalResult = await tool.call(
            (toolArgs ?? {}) as never,
            toolUseContext,
            hasPermissionsToUseTool,
            createAssistantMessage({
              content: [],
            }),
          )

          let content: CallToolResult['content']
          const data = finalResult.data as string | { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] | unknown

          if (typeof data === 'string') {
            content = [{ type: 'text', text: data }]
          } else if (Array.isArray(data)) {
            content = data.map((block: any) => {
              if (block.type === 'text') {
                return { type: 'text', text: block.text || '' }
              } else if (block.type === 'image' && block.source) {
                return {
                  type: 'image',
                  data: block.source.data,
                  mimeType: block.source.media_type,
                }
              } else {
                // eslint-disable-next-line custom-rules/no-top-level-side-effects, no-console
                console.warn(`Unmapped content block type from tool ${name}: ${block.type || 'unknown'}`)
                return { type: 'text', text: jsonStringify(block) }
              }
            }) as CallToolResult['content']
          } else {
            content = [{ type: 'text', text: jsonStringify(data) }]
          }

          return {
            content,
            isError: !!(finalResult as any).isError,
          }
        } catch (error) {
          logError(error)

          if (error instanceof ZodError) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Tool ${name} input is invalid:\n${error.issues.map(e => `- ${e.path.join('.')}: ${e.message}`).join('\n')}`,
                },
              ],
            }
          }

          const parts =
            error instanceof Error ? getErrorParts(error) : [String(error)]
          const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
          }
        }
      },
    )

    return server
  }

  serveStdio(createServer, { legacy: 'serve' })
}
