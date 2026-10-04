import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js'
import type { PermissionResult } from 'src/shared/types/permissions.js'
import type { Tool } from 'src/tools/Tool.js'
import { MCPTool } from 'src/tools/MCPTool/MCPTool.js'
import { classifyMcpToolForCollapse } from 'src/tools/MCPTool/classifyForCollapse.js'
import { buildMcpToolName } from 'src/mcp/mcpStringUtils.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { MAX_MCP_DESCRIPTION_LENGTH } from 'src/mcp/client/connection.js'
import { callListedTool } from 'src/mcp/client/capabilities/toolCall.js'

export type ListedTool = ListToolsResult['tools'][number]

export type ToolFromListingOptions = {
  /** Offer the tool under the server's own name instead of `mcp__server__tool`. */
  bareName: boolean
}

const TRUNCATION_MARKER = '… [truncated]'
const SEARCH_HINT_KEY = 'anthropic/searchHint'
const ALWAYS_LOAD_KEY = 'anthropic/alwaysLoad'

/** `key=value` words for the auto-mode classifier; the tool's name when there is nothing to show. */
export function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const pairs = Object.entries(input).map(([key, value]) => `${key}=${String(value)}`)
  return pairs.length > 0 ? pairs.join(' ') : toolName
}

/** Model-facing text: long descriptions are cut so one server cannot flood the prompt. */
export function capDescription(text: string): string {
  if (text.length <= MAX_MCP_DESCRIPTION_LENGTH) return text
  return text.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + TRUNCATION_MARKER
}

export function readSearchHint(meta: ListedTool['_meta']): string | undefined {
  const raw = meta?.[SEARCH_HINT_KEY]
  if (typeof raw !== 'string') return undefined
  const collapsed = raw.split(/\s+/).filter(Boolean).join(' ')
  return collapsed === '' ? undefined : collapsed
}

export function readAlwaysLoad(meta: ListedTool['_meta']): boolean {
  return meta?.[ALWAYS_LOAD_KEY] === true
}

/**
 * Turns one entry of a (sanitized) `tools/list` answer into a Tool. The
 * permission rule it suggests always names the qualified tool, so a bare-named
 * SDK tool can never be allowed by a rule written for a built-in.
 */
export function toolFromListing(
  server: ConnectedMCPServer,
  listed: ListedTool,
  options: ToolFromListingOptions,
): Tool {
  const qualifiedName = buildMcpToolName(server.name, listed.name)
  const description = listed.description ?? ''
  const hints = listed.annotations ?? {}
  const readOnly = hints.readOnlyHint ?? false
  const permission: PermissionResult = {
    behavior: 'passthrough',
    message: 'MCPTool requires permission.',
    suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: qualifiedName, ruleContent: undefined }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
  }

  return {
    ...MCPTool,
    name: options.bareName ? listed.name : qualifiedName,
    mcpInfo: { serverName: server.name, toolName: listed.name },
    isMcp: true,
    searchHint: readSearchHint(listed._meta),
    alwaysLoad: readAlwaysLoad(listed._meta),
    inputJSONSchema: listed.inputSchema as Tool['inputJSONSchema'],
    async description() {
      return description
    },
    async prompt() {
      return capDescription(description)
    },
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    isDestructive: () => hints.destructiveHint ?? false,
    isOpenWorld: () => hints.openWorldHint ?? false,
    isSearchOrReadCommand: () => classifyMcpToolForCollapse(server.name, listed.name),
    userFacingName: () => `${server.name} - ${hints.title || listed.name} (MCP)`,
    toAutoClassifierInput: input => mcpToolInputToAutoClassifierInput(input, listed.name),
    async checkPermissions() {
      return permission
    },
    call: (args, context, _canUseTool, parentMessage, onProgress) =>
      callListedTool({ server, toolName: listed.name, args, context, parentMessage, onProgress }),
  }
}
