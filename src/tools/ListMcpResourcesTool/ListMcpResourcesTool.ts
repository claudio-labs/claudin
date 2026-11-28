import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
  fetchResourceTemplatesForClient,
} from 'src/mcp/client.js'
import { eventsRefusal } from 'src/mcp/client/events.js'
import { fetchEventTypesForClient } from 'src/mcp/client/fetchCapabilities.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { errorMessage } from 'src/shared/errors.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { logMCPError } from 'src/shared/log.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { isOutputLineTruncated } from 'src/terminal/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from 'src/tools/ListMcpResourcesTool/prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from 'src/tools/ListMcpResourcesTool/UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter resources by'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.union([
      z.object({
        uri: z.string().describe('Resource URI'),
        name: z.string().describe('Resource name'),
        mimeType: z.string().optional().describe('MIME type of the resource'),
        description: z.string().optional().describe('Resource description'),
        server: z.string().describe('Server that provides this resource'),
      }),
      z.object({
        uriTemplate: z.string().describe('RFC 6570 URI template; fill it in to get a resource URI'),
        name: z.string().describe('Template name'),
        mimeType: z.string().optional().describe('MIME type of the resources it names'),
        description: z.string().optional().describe('Template description'),
        server: z.string().describe('Server that provides this template'),
      }),
      z.object({
        event: z.string().describe("MCP event name; watch it with Monitor's mcp_event"),
        description: z.string().optional().describe('Event description'),
        delivery: z.array(z.string()).optional().describe('How the server delivers it: push, poll, webhook'),
        inputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema of the event's args"),
        server: z.string().describe('Server that publishes this event'),
      }),
    ]),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
type Entry = Output[number]
type EventEntry = Extract<Entry, { event: string }>

function isEventEntry(entry: Entry): entry is EventEntry {
  return 'event' in entry
}

/**
 * The event types a server publishes (SEP-3415), or none: a server without
 * the extension is not asked, and a failed list costs only its own section.
 */
async function eventEntries(connection: ConnectedMCPServer): Promise<EventEntry[]> {
  if (eventsRefusal(connection)) return []
  try {
    const types = await fetchEventTypesForClient(connection)
    return types.map(type => ({
      event: type.name,
      ...(type.description !== undefined && { description: type.description }),
      ...(type.delivery !== undefined && { delivery: type.delivery }),
      ...(type.inputSchema !== undefined && { inputSchema: type.inputSchema }),
      server: connection.name,
    }))
  } catch (error) {
    logMCPError(connection.name, `Failed to list events: ${errorMessage(error)}`)
    return []
  }
}

export const ListMcpResourcesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources from connected MCP servers',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients } }) {
    const { server: targetServer } = input

    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `Server "${targetServer}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // fetchResourcesForClient is LRU-cached (by server name) and already
    // warm from startup prefetch; the templates are fetched here on first
    // use and cached the same way. Both caches are invalidated on onclose
    // and on resources/list_changed notifications, so results are never stale.
    // ensureConnectedClient is a no-op when healthy (memoize hit), but after
    // onclose it returns a fresh connection so the re-fetch succeeds.
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const fresh = await ensureConnectedClient(client)
          const [resources, templates, events] = await Promise.all([
            fetchResourcesForClient(fresh),
            fetchResourceTemplatesForClient(fresh),
            eventEntries(fresh),
          ])
          return [...resources, ...templates, ...events]
        } catch (error) {
          // One server's reconnect failure shouldn't sink the whole result.
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    return {
      data: results.flat(),
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResources',
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const entries = content ?? []
    const resources = entries.filter(entry => !isEventEntry(entry))
    const events = entries.filter(isEventEntry)
    const listed =
      resources.length === 0
        ? 'No resources found. MCP servers may still provide tools even if they have no resources.'
        : jsonStringify(resources)
    // Only a server that publishes events adds the section, so every other
    // result reads as it always has.
    const section =
      events.length === 0
        ? ''
        : `\n\nMCP event types (watch one with Monitor's mcp_event: {server, event, args?}):\n${jsonStringify(events)}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: listed + section,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
