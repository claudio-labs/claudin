import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import type { MCPProgress } from 'src/shared/types/tools.js'
import type { ToolCallProgress, ToolResult, ToolUseContext } from 'src/tools/Tool.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type { MCPToolResult } from 'src/mcp/mcpValidation.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import {
  callMCPToolWithUrlElicitationRetry,
  extractToolUseId,
} from 'src/mcp/client/callTool.js'
import { ensureConnectedClient } from 'src/mcp/client/connection.js'
import { McpSessionExpiredError } from 'src/mcp/client/errors.js'

const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'
const CALL_FAILED_TELEMETRY = 'MCP tool call failed'

type CallOutcome = Awaited<ReturnType<typeof callMCPToolWithUrlElicitationRetry>>
type McpMeta = NonNullable<ToolResult<unknown>['mcpMeta']>

export type ListedToolCall = {
  server: ConnectedMCPServer
  toolName: string
  args: Record<string, unknown>
  context: ToolUseContext
  parentMessage: AssistantMessage
  onProgress?: ToolCallProgress
}

type Lifecycle = {
  started(): void
  relay(data: MCPProgress): void
  finished(status: 'completed' | 'failed'): void
}

const silentLifecycle: Lifecycle = { started() {}, relay() {}, finished() {} }

/** Progress is only reported when there is a tool_use id to attach it to. */
function lifecycleFor(
  server: string,
  tool: string,
  toolUseID: string | undefined,
  onProgress: ToolCallProgress | undefined,
): Lifecycle {
  if (!toolUseID || !onProgress) return silentLifecycle
  const startedAt = Date.now()
  const emit = (data: MCPProgress) => onProgress({ toolUseID, data })
  const base = { type: 'mcp_progress', serverName: server, toolName: tool } as const
  return {
    started: () => emit({ ...base, status: 'started' }),
    relay: emit,
    finished: status => emit({ ...base, status, elapsedTimeMs: Date.now() - startedAt }),
  }
}

/** Only the metadata the server actually sent goes to SDK consumers. */
export function pickMcpMeta(outcome: Pick<CallOutcome, '_meta' | 'structuredContent'>): McpMeta | undefined {
  const meta: McpMeta = {}
  if (outcome._meta) meta._meta = outcome._meta
  if (outcome.structuredContent) meta.structuredContent = outcome.structuredContent
  return Object.keys(meta).length > 0 ? meta : undefined
}

/** Plain and SDK errors carry server text, so they leave as telemetry-safe errors with a fixed telemetry label. */
export function toTelemetrySafe(error: unknown): unknown {
  if (error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) return error
  if (error instanceof Error) {
    return new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(error.message, CALL_FAILED_TELEMETRY)
  }
  return error
}

export async function callListedTool(call: ListedToolCall): Promise<ToolResult<MCPToolResult>> {
  const { server, toolName, args, context } = call
  const toolUseId = extractToolUseId(call.parentMessage)
  const lifecycle = lifecycleFor(server.name, toolName, toolUseId, call.onProgress)
  const meta = toolUseId ? { [TOOL_USE_ID_META_KEY]: toolUseId } : undefined

  const attempt = async (): Promise<CallOutcome> =>
    callMCPToolWithUrlElicitationRetry({
      client: await ensureConnectedClient(server),
      clientConnection: server,
      tool: toolName,
      args,
      meta,
      signal: context.abortController.signal,
      setAppState: context.setAppState,
      onProgress: lifecycle.relay,
      handleElicitation: context.handleElicitation,
    })

  lifecycle.started()
  try {
    let outcome: CallOutcome
    try {
      outcome = await attempt()
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error
      outcome = await attempt()
    }
    lifecycle.finished('completed')
    const mcpMeta = pickMcpMeta(outcome)
    return mcpMeta ? { data: outcome.content, mcpMeta } : { data: outcome.content }
  } catch (error) {
    lifecycle.finished('failed')
    throw toTelemetrySafe(error)
  }
}
