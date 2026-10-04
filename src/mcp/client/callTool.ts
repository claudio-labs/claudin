import {
  type CallToolResult,
  CallToolResultSchema,
  type ElicitRequestURLParams,
  type ElicitResult,
  type Progress,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import type { MCPToolResult } from 'src/mcp/mcpValidation.js'
import type { MCPProgress } from 'src/tools/MCPTool/MCPTool.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from 'src/mcp/types.js'
import { clearServerCache } from 'src/mcp/client/connection.js'
import {
  McpAuthError,
  McpSessionExpiredError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/mcp/client/errors.js'
import { classifyCallError } from 'src/mcp/client/callErrors.js'
import { elicitationEndedText } from 'src/mcp/client/modelTexts.js'
import { processMCPResult } from 'src/mcp/client/toolResult.js'
import { callWithUrlElicitation, resolveUrlElicitation } from 'src/mcp/client/urlElicitation.js'

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300_000

// setTimeout fires at once past this, so a larger setting is held to it.
const LONGEST_TIMER_MS = 2 ** 31 - 1
const STILL_RUNNING_LOG_EVERY_MS = 30_000

function getMcpToolTimeoutMs(): number {
  const configured = Number.parseInt(process.env.MCP_TOOL_TIMEOUT ?? '', 10)
  const timeout = configured > 0 ? configured : DEFAULT_MCP_TOOL_TIMEOUT_MS
  return Math.min(timeout, LONGEST_TIMER_MS)
}

type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

type CallToolOptions = {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}

export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  /** Injectable for testing. Defaults to callMCPTool. */
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  /** Settles URL elicitations no hook answered (SDK and print mode). Without it, the REPL's dialog queue does. */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
}): Promise<MCPToolCallResult> {
  const serverName = clientConnection.type === 'connected' ? clientConnection.name : 'unknown'
  const outcome = await callWithUrlElicitation(
    () => callToolFn({ client: connectedClient, tool, args, meta, signal, onProgress }),
    params => resolveUrlElicitation(params, { serverName, signal, setAppState, handleElicitation }),
    signal,
  )
  if (outcome.kind === 'done') return outcome.result
  return { content: elicitationEndedText(outcome.ending, tool) }
}

/** Rejects after `ms` with the error `onTimeout` builds; `cancel` clears the timer. */
function deadline(ms: number, onTimeout: () => Error): { expired: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return { expired, cancel: () => clearTimeout(timer) }
}

function progressEvent(serverName: string, toolName: string, progress: Progress): MCPProgress {
  return {
    type: 'mcp_progress',
    status: 'progress',
    serverName,
    toolName,
    progress: progress.progress,
    total: progress.total,
    progressMessage: progress.message,
  }
}

/** Spec, finding 7: only the first block counts, and it must be text. */
function toolErrorMessage(result: CallToolResult): string {
  const [first] = result.content
  if (first?.type === 'text') return first.text
  if (first === undefined && typeof result.error === 'string') return result.error
  return 'Unknown error'
}

async function surfaceCallError(error: unknown, server: ConnectedMCPServer): Promise<unknown> {
  const { name, config } = server
  switch (classifyCallError(error, config.type)) {
    case 'auth':
      return new McpAuthError(name, `MCP server "${name}" requires re-authorization (token expired)`)
    case 'expired':
      try {
        await clearServerCache(name, config)
      } catch (clearError) {
        logMCPError(name, clearError)
      }
      return new McpSessionExpiredError(name)
    case 'passthrough':
      return error
  }
}

async function requestToolCall(
  { client: server, tool, args, meta, signal, onProgress }: CallToolOptions,
  timeoutMs: number,
): Promise<CallToolResult> {
  const { client, name } = server
  // Started before the request, so it fires before the SDK's timer of the same length.
  const limit = deadline(
    timeoutMs,
    () =>
      new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
        'MCP tool call timed out',
      ),
  )
  const startedAt = Date.now()
  const stillRunning = setInterval(
    () => logMCPDebug(name, `Tool "${tool}" still running after ${Math.round((Date.now() - startedAt) / 1000)}s`),
    STILL_RUNNING_LOG_EVERY_MS,
  )
  try {
    const request = client.callTool({ name: tool, arguments: args, _meta: meta }, CallToolResultSchema, {
      signal,
      timeout: timeoutMs,
      // Only when asked: a progress handler makes the SDK add a progressToken to _meta.
      ...(onProgress && { onprogress: (progress: Progress) => onProgress(progressEvent(name, tool, progress)) }),
    })
    return CallToolResultSchema.parse(await Promise.race([request, limit.expired]))
  } finally {
    limit.cancel()
    clearInterval(stillRunning)
  }
}

export async function callMCPTool({
  client: server,
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const { name } = server
  logMCPDebug(name, `Calling tool "${tool}"`)
  let result: CallToolResult
  try {
    result = await requestToolCall({ client: server, tool, args, meta, signal, onProgress }, getMcpToolTimeoutMs())
  } catch (error) {
    logMCPDebug(name, `Tool "${tool}" failed: ${String(error)}`)
    throw await surfaceCallError(error, server)
  }
  if (result.isError) {
    const message = toolErrorMessage(result)
    throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      message,
      `MCP tool [${name}] ${tool}: ${message}`,
      result._meta ? { _meta: result._meta } : undefined,
    )
  }
  const content = await processMCPResult(result, tool, name)
  return { content, _meta: result._meta, structuredContent: result.structuredContent }
}

export function extractToolUseId(
  message: AssistantMessage,
): string | undefined {
  const content = message.message.content
  if (!Array.isArray(content)) return undefined
  const [first] = content
  return first?.type === 'tool_use' ? first.id : undefined
}
