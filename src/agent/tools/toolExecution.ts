import { feature } from 'bun:bundle'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  addToToolDuration,
  getStatsStore,
} from 'src/platform/bootstrap/state.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import {
  findToolByName,
  type Tool,
  type ToolAdvice,
  type ToolProgress,
  type ToolProgressData,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import type { BashToolInput } from 'src/tools/BashTool/bashSchemas.js'
import { startSpeculativeClassifierCheck } from 'src/tools/BashTool/bashPermissions.js'
import { isReadAdviceMoot } from 'src/tools/BashTool/redirectLanes.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import { invalidateCacheForWrite } from 'src/agent/tools/cacheInvalidation.js'
import {
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from 'src/tools/ToolSearchTool/prompt.js'
import { getAllBaseTools } from 'src/tools/tools.js'
import type { HookProgress } from 'src/shared/types/hooks.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  StopHookInfo,
} from 'src/shared/types/message.js'
import { count } from 'src/shared/data/array.js'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  AbortError,
  errorMessage,
  getErrnoCode,
  isAbortError,
  ShellError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/shared/errors.js'
import { executePermissionDeniedHooks } from 'src/platform/lifecycleHooks/hooks.js'
import { logError } from 'src/shared/log.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import {
  detectSerialEditStreak,
  EDIT_TOOL_NAMES,
  renderSerialEditNudge,
  SERIAL_EDIT_THRESHOLD,
} from 'src/tools/shared/serialEditNudge.js'
import {
  countIdenticalFailures,
  REPEATED_ERROR_THRESHOLD,
} from 'src/memory/extract/loopDetector.js'
import {
  CANCEL_MESSAGE,
  createProgressMessage,
  createStopHookSummaryMessage,
  createToolResultStopMessage,
  createUserMessage,
  withMemoryCorrectionHint,
} from 'src/agent/messages/messages.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/permissions/PermissionResult.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from 'src/sessions/sessionActivity.js'
import { Stream } from 'src/shared/stream.js'
import { stripPlaceholderOptionalFields } from 'src/agent/tools/toolInputPlaceholders.js'
import { transportSendsStrictToolSchemas } from 'src/providers/presets/providerConfig.js'
import {
  formatError,
  formatZodValidationError,
} from 'src/agent/tools/toolErrors.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from 'src/agent/tools/toolResultStorage.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
} from 'src/agent/tools/toolSearch.js'
import {
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/mcp/client.js'
import { mcpInfoFromString } from 'src/mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from 'src/mcp/normalization.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import {
  getLoggingSafeMcpBaseUrl,
  isMcpTool,
} from 'src/mcp/utils.js'
import {
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseFailureHooksForUnits,
  runPostToolUseHooks,
  runPostToolUseHooksForUnits,
  runPreToolUseHooks,
  runPreToolUseHooksForUnits,
} from 'src/agent/tools/toolHooks.js'

/** Minimum total hook duration (ms) to show inline timing summary */
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500
/** Log a debug warning when hooks/permission-decision block for this long. Matches
 * BashTool's PROGRESS_THRESHOLD_MS — the collapsed view feels stuck past this. */
const SLOW_PHASE_LOG_THRESHOLD_MS = 2000

/**
 * Classify a tool execution error into a telemetry-safe string.
 *
 * In minified/external builds, `error.constructor.name` is mangled into
 * short identifiers like "nJT" or "Chq" — useless for diagnostics.
 * This function extracts structured, telemetry-safe information instead:
 * - TelemetrySafeError: use its telemetryMessage (already vetted)
 * - Node.js fs errors: log the error code (ENOENT, EACCES, etc.)
 * - Known error types: use their unminified name
 * - Fallback: "Error" (better than a mangled 3-char identifier)
 */
export function classifyToolError(error: unknown): string {
  if (
    error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  ) {
    return error.telemetryMessage.slice(0, 200)
  }
  if (error instanceof Error) {
    // Node.js filesystem errors have a `code` property (ENOENT, EACCES, etc.)
    // These are safe to log and much more useful than the constructor name.
    const errnoCode = getErrnoCode(error)
    if (typeof errnoCode === 'string') {
      return `Error:${errnoCode}`
    }
    // ShellError, ImageSizeError, etc. have stable `.name` properties
    // that survive minification (they're set in the constructor).
    if (error.name && error.name !== 'Error' && error.name.length > 3) {
      return error.name.slice(0, 60)
    }
    return 'Error'
  }
  return 'UnknownError'
}

function getNextImagePasteId(messages: Message[]): number {
  let maxId = 0
  for (const message of messages) {
    if (message.type === 'user' && message.imagePasteIds) {
      for (const id of message.imagePasteIds) {
        if (id > maxId) maxId = id
      }
    }
  }
  return maxId + 1
}

export type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}

export type McpServerType =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'sse-ide'
  | 'ws-ide'
  | 'claudeai-proxy'
  | undefined

function findMcpServerConnection(
  toolName: string,
  mcpClients: MCPServerConnection[],
): MCPServerConnection | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return undefined
  }

  // mcpInfo.serverName is normalized (e.g., "claude_ai_Slack"), but client.name
  // is the original name (e.g., "claude.ai Slack"). Normalize both for comparison.
  return mcpClients.find(
    client => normalizeNameForMCP(client.name) === mcpInfo.serverName,
  )
}

/**
 * Extracts the MCP server transport type from a tool name.
 * Returns the server type (stdio, sse, http, ws, sdk, etc.) for MCP tools,
 * or undefined for built-in tools.
 */
function getMcpServerType(
  toolName: string,
  mcpClients: MCPServerConnection[],
): McpServerType {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)

  if (serverConnection?.type === 'connected') {
    // Handle stdio configs where type field is optional (defaults to 'stdio')
    return serverConnection.config.type ?? 'stdio'
  }

  return undefined
}

/**
 * Extracts the MCP server base URL for a tool by looking up its server connection.
 * Returns undefined for stdio servers, built-in tools, or if the server is not connected.
 */
function getMcpServerBaseUrlFromToolName(
  toolName: string,
  mcpClients: MCPServerConnection[],
): string | undefined {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)
  if (serverConnection?.type !== 'connected') {
    return undefined
  }
  return getLoggingSafeMcpBaseUrl(serverConnection.config)
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name
  // First try to find in the available tools (what the model sees)
  let tool = findToolByName(toolUseContext.options.tools, toolName)

  // If not found, check if it's a deprecated tool being called by alias
  // (e.g., old transcripts calling "KillShell" which is now an alias for "TaskStop")
  // Only fall back for tools where the name matches an alias, not the primary name
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    // Only use fallback if the tool was found via alias (deprecated name)
    if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
      tool = fallbackTool
    }
  }
  const messageId = assistantMessage.message.id
  const requestId = assistantMessage.requestId
  const mcpServerType = getMcpServerType(
    toolName,
    toolUseContext.options.mcpClients,
  )
  const mcpServerBaseUrl = getMcpServerBaseUrlFromToolName(
    toolName,
    toolUseContext.options.mcpClients,
  )

  // Check if the tool exists
  if (!tool) {
    logForDebugging(`Unknown tool ${toolName}: ${toolUse.id}`)
    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withRepeatedFailureHint(
              `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
              toolName,
              toolUse.input,
              toolUseContext,
            ),
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: `Error: No such tool available: ${toolName}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    }
    return
  }

  // The Codex transport cannot express "argument omitted": it forces every
  // property into `required`, so the model sends a placeholder ("" / null) for
  // the ones it did not want to pass. Drop those before anything downstream —
  // validation, permissions and the repeated-failure streak all key off this
  // object. Gated on the transport this request actually uses, because `""` is
  // a legitimate argument everywhere else; the model is passed explicitly
  // since a session can run a different model than its profile's primary
  // (`/model`, a sub-agent override, the fallback model). The whole tool goes
  // in, not its zod schema: an MCP tool's real schema is inputJSONSchema.
  let toolInput = toolUse.input as { [key: string]: string }
  try {
    if (transportSendsStrictToolSchemas(toolUseContext.options.mainLoopModel)) {
      toolInput = stripPlaceholderOptionalFields(tool, toolInput)
    }

    if (toolUseContext.abortController.signal.aborted) {
      const content = createToolResultStopMessage(toolUse.id)
      content.content = withMemoryCorrectionHint(CANCEL_MESSAGE)
      yield {
        message: createUserMessage({
          content: [content],
          toolUseResult: CANCEL_MESSAGE,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      }
      return
    }

    for await (const update of streamedCheckPermissionsAndCallTool(
      tool,
      toolUse.id,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      messageId,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      yield update
    }
  } catch (error) {
    logError(error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    const toolInfo = tool ? ` (${tool.name})` : ''
    const detailedError = `Error calling tool${toolInfo}: ${errorMessage}`

    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withRepeatedFailureHint(
              `<tool_use_error>${detailedError}</tool_use_error>`,
              tool.name,
              toolInput,
              toolUseContext,
              // Same exclusion the inner error path applies at the bottom of
              // this file: a user interrupt is not a failure. Without it a
              // cancelled call renders as `Error calling tool (X): …`, which
              // matches none of the USER_CONTROL_SENTINELS, so it both
              // receives the hint and counts toward a later streak — telling
              // the model it "failed 4 times in a row" for aborts the user
              // asked for.
              //
              // isAbortError, not `instanceof AbortError`: this is the
              // outermost catch, so it also sees the raw DOMException an
              // AbortSignal throws and the SDK's APIUserAbortError, neither of
              // which is our class. utils/errors.ts owns that classification.
              isAbortError(error),
            ),
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: detailedError,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    }
  }
}

/**
 * Just-in-time nudge for a model that keeps re-issuing a call which keeps
 * failing. Appended to the errored tool_result itself (same injection surface
 * as withMemoryCorrectionHint) once the same (tool, canonical input) has
 * failed REPEATED_ERROR_THRESHOLD times in the active task.
 */
function renderRepeatedFailureHint(
  toolName: string,
  failures: number,
): string {
  return `\n\n<system-reminder>\nThis exact ${toolName} call has now failed ${failures} times in a row with the same input — repeating it will fail the same way. Do not re-issue it unchanged: correct the input, verify your assumption with a different tool, or change approach.\n</system-reminder>`
}

/**
 * Appends the repeated-failure hint when this errored result completes a
 * streak of identical failures. Interrupts/cancels/denials never qualify —
 * they are user actions, not a failing approach (loopDetector's
 * USER_CONTROL_SENTINELS enforces the same rule on the counting side).
 */
export function withRepeatedFailureHint(
  content: string,
  toolName: string,
  input: unknown,
  toolUseContext: ToolUseContext,
  isInterrupt = false,
): string {
  if (isInterrupt) return content
  // Default on, like the bash output filter. It has a toggle because it
  // changes model-facing bytes for EVERY tool, not just the one whose branch
  // shipped it — a user who never touches the Read clip-pin should still be
  // able to turn this off. Surfaced to users as /config → "Repeated-failure
  // hint"; `repeatedFailureHintEnabled: false` in the global config is the same
  // switch. Not listed in AGENTS.md — that file describes the repo, and every
  // other harness that reads it has no such behavior to honor.
  if (getGlobalConfig().repeatedFailureHintEnabled === false) return content
  const messages = toolUseContext.messages
  if (!Array.isArray(messages)) return content
  // countIdenticalFailures only sees results already in the transcript; the
  // one being built right now is the next in the streak.
  //
  // The scan walks up to MAX_SCAN_MESSAGES and canonicalizes every tool_use
  // input in the window — including whole file bodies from Write/Edit — so a
  // batch of N failing tools in one turn would do N full walks synchronously
  // on the render thread. The threshold check is cheap and almost always
  // false, so the walk is memoized on the transcript itself — array identity
  // plus length, since it is appended in place (collectFailureStatsMemoized
  // in loopDetector) — and all N failing tools in a turn share one walk.
  const failures = countIdenticalFailures(messages, toolName, input) + 1
  if (failures < REPEATED_ERROR_THRESHOLD) return content
  return content + renderRepeatedFailureHint(toolName, failures)
}

/**
 * Just-in-time nudge for a model landing one file per edit turn instead of
 * batching the change into a single atomic patch. Appended to the SUCCESSFUL
 * tool_result: the errored paths already carry withRepeatedFailureHint, and
 * stacking two <system-reminder>s on one failure buries both.
 *
 * Gated OFF by default (SERIAL_EDIT_NUDGE in scripts/build/build.ts). The sibling
 * intervention, SERIAL_READ_NUDGE, was benched at zero adoption and killed, so
 * an appended reminder is not assumed to work — this exists to be measured. The
 * part of the same work that does not depend on persuasion (read-before-edit
 * refusals that name `view='full'` instead of claiming the file was never read)
 * is unconditional and lives in applyPatch.ts / FileEditTool.ts.
 */
function withSerialEditHint(
  block: ToolResultBlockParam,
  toolName: string,
  toolUseContext: ToolUseContext,
  currentInput: unknown,
): ToolResultBlockParam {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) return block
  // `feature()` must sit directly in an if/ternary for the build preprocessor.
  if (!feature('SERIAL_EDIT_NUDGE')) return block
  if (!EDIT_TOOL_NAMES.has(toolName)) return block
  // Non-string content is an image/structured result; there is nothing to
  // append to without changing the block's shape.
  if (typeof block.content !== 'string') return block
  const messages = toolUseContext.messages
  if (!Array.isArray(messages)) return block
  // The call being answered is NOT in `messages` — query.ts freezes that array
  // before the current turn streams — so it has to be passed in explicitly.
  // Without it a successful multi-file patch gets nudged for the single-file
  // turns that preceded it, which inverts the whole instrument.
  const streak = detectSerialEditStreak(messages, {
    currentCall: { name: toolName, input: currentInput },
  })
  if (streak < SERIAL_EDIT_THRESHOLD) return block
  return { ...block, content: block.content + renderSerialEditNudge(streak) }
}

/** A tool's advice for this call, fail-open: a throwing `advise` must not cost the call. */
function askToolAdvice(
  tool: Tool,
  input: unknown,
  toolUseContext: ToolUseContext,
): ToolAdvice | null {
  if (!tool.advise) return null
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) return null
  try {
    return tool.advise(input as never, toolUseContext)
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * The advice as the reminder appended to a result. When the tool it points at
 * is deferred and not loaded in this conversation, the note also names the
 * ToolSearch call that loads it — without that line a model that decides to
 * switch would call a tool it has no schema for.
 */
export function renderToolAdvice(
  advice: ToolAdvice,
  tools: readonly Tool[],
  messages: Message[],
): string {
  const target = advice.suggests ? findToolByName(tools, advice.suggests) : undefined
  const load =
    target && isUnloadedDeferredTool(target, tools, messages)
      ? ` ${target.name} is deferred: load it first with ${TOOL_SEARCH_TOOL_NAME} "select:${target.name}".`
      : ''
  return `\n\n<system-reminder>\n${advice.message}${load}\n</system-reminder>`
}

function withToolAdvice(block: ToolResultBlockParam, note: string | null): ToolResultBlockParam {
  if (!note) return block
  if (typeof block.content === 'string') return { ...block, content: block.content + note }
  if (Array.isArray(block.content)) {
    return { ...block, content: [...block.content, { type: 'text', text: note.trimStart() }] }
  }
  return { ...block, content: note.trimStart() }
}

/**
 * The advice note a successful result carries. A Bash `cat` whose every file
 * the read credit counted (`creditedFiles`, BashTool/creditShownFiles.ts)
 * keeps no note sending the model to Read them: it would only read again what
 * it holds (redirectLanes.ts, `isReadAdviceMoot`).
 */
export function adviceNoteAfterCall(
  tool: Pick<Tool, 'name'>,
  input: unknown,
  output: unknown,
  note: string | null,
): string | null {
  if (note === null || tool.name !== BASH_TOOL_NAME) return note
  const command = (input as { command?: unknown } | null)?.command
  const credited = (output as { creditedFiles?: unknown } | null)?.creditedFiles
  if (typeof command !== 'string' || !Array.isArray(credited)) return note
  const paths = credited.filter((path): path is string => typeof path === 'string')
  return isReadAdviceMoot(command, getCwd(), paths) ? null : note
}

function streamedCheckPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
): AsyncIterable<MessageUpdateLazy> {
  // This is a bit of a hack to get progress events and final results
  // into a single async iterable.
  //
  // Ideally the progress reporting and tool call reporting would
  // be via separate mechanisms.
  const stream = new Stream<MessageUpdateLazy>()
  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
    progress => {
      stream.enqueue({
        message: createProgressMessage({
          toolUseID: progress.toolUseID,
          parentToolUseID: toolUseID,
          data: progress.data,
        }),
      })
    },
  )
    .then(results => {
      for (const result of results) {
        stream.enqueue(result)
      }
    })
    .catch(error => {
      stream.error(error)
    })
    .finally(() => {
      stream.done()
    })
  return stream
}

/**
 * Appended to Zod errors when a deferred tool wasn't in the discovered-tool
 * set — re-runs the claude.ts schema-filter scan dispatch-time to detect the
 * mismatch. The raw Zod error ("expected array, got string") doesn't tell the
 * model to re-load the tool; this hint does. Null if the schema was sent.
 */
export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
): string | null {
  if (!isUnloadedDeferredTool(tool, tools, messages)) return null
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}

/**
 * A deferred tool whose schema this conversation has not loaded yet.
 *
 * Optimistic gating — reconstructing claude.ts's full useToolSearch
 * computation is fragile. The first two gates prevent pointing at a ToolSearch
 * that isn't callable; occasional misfires (Haiku, tst-auto below threshold)
 * cost one extra round-trip.
 */
function isUnloadedDeferredTool(
  tool: Tool,
  tools: readonly { name: string }[],
  messages: Message[],
): boolean {
  if (!isToolSearchEnabledOptimistic()) return false
  if (!isToolSearchToolAvailable(tools)) return false
  if (!isDeferredTool(tool)) return false
  return !extractDiscoveredToolNames(messages).has(tool.name)
}

export function getSchemaValidationErrorOverride(
  tool: Tool,
  input: unknown,
): string | null {
  if (tool.name !== SKILL_TOOL_NAME || !input || typeof input !== 'object') {
    return null
  }

  const skill = (input as { skill?: unknown }).skill
  if (skill === undefined || skill === null) {
    return 'Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).'
  }

  return null
}

export function getSchemaValidationToolUseResult(
  tool: Tool,
  input: unknown,
  fallbackMessage?: string,
): string {
  const override = getSchemaValidationErrorOverride(tool, input)
  return `InputValidationError: ${override ?? fallbackMessage ?? ''}`
}

async function checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
  onToolProgress: (
    progress: ToolProgress<ToolProgressData> | ProgressMessage<HookProgress>,
  ) => void,
): Promise<MessageUpdateLazy[]> {
  // Validate input types with zod (surprisingly, the model is not great at generating valid input)
  const parsedInput = tool.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    const fallbackErrorContent = formatZodValidationError(tool.name, parsedInput.error)
    let errorContent =
      getSchemaValidationErrorOverride(tool, input) ?? fallbackErrorContent

    const schemaHint = buildSchemaNotSentHint(
      tool,
      toolUseContext.messages,
      toolUseContext.options.tools,
    )
    if (schemaHint) {
      errorContent += schemaHint
    }

    logForDebugging(
      `${tool.name} tool input error: ${errorContent.slice(0, 200)}`,
    )
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: withRepeatedFailureHint(
                `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
                tool.name,
                input,
                toolUseContext,
              ),
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: getSchemaValidationToolUseResult(
            tool,
            input,
            parsedInput.error.message,
          ),
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }

  // A tool may resolve a reference in its input to what will actually run
  // (Tool.resolveInput). Everything below sees the resolved form; the
  // transcript keeps what the model sent.
  const resolution = tool.resolveInput
    ? tool.resolveInput(parsedInput.data, toolUseContext)
    : ({ ok: true, input: parsedInput.data } as const)
  if (!resolution.ok) {
    logForDebugging(
      `${tool.name} tool input resolution error: ${resolution.message.slice(0, 200)}`,
    )
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: withRepeatedFailureHint(
                `<tool_use_error>${resolution.message}</tool_use_error>`,
                tool.name,
                input,
                toolUseContext,
              ),
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `Error: ${resolution.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }
  const resolvedInput = resolution.input

  // Validate input values. Each tool has its own validation logic
  const isValidCall = await tool.validateInput?.(
    resolvedInput,
    toolUseContext,
  )
  if (isValidCall?.result === false) {
    logForDebugging(
      `${tool.name} tool validation error: ${isValidCall.message?.slice(0, 200)}`,
    )
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: withRepeatedFailureHint(
                `<tool_use_error>${isValidCall.message}</tool_use_error>`,
                tool.name,
                input,
                toolUseContext,
              ),
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `Error: ${isValidCall.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }
  // Speculatively start the bash allow classifier check early so it runs in
  // parallel with pre-tool hooks, deny/ask classifiers, and permission dialog
  // setup. The UI indicator (setClassifierChecking) is NOT set here — it's
  // set in interactiveHandler.ts only when the permission check returns `ask`
  // with a pendingClassifierCheck. This avoids flashing "classifier running"
  // for commands that auto-allow via prefix rules.
  if (
    tool.name === BASH_TOOL_NAME &&
    resolvedInput &&
    'command' in resolvedInput
  ) {
    const appState = toolUseContext.getAppState()
    startSpeculativeClassifierCheck(
      (resolvedInput as BashToolInput).command,
      appState.toolPermissionContext,
      toolUseContext.abortController.signal,
      toolUseContext.options.isNonInteractiveSession,
    )
  }

  const resultingMessages = []

  // Defense-in-depth: strip _simulatedSedEdit from model-provided Bash input.
  // This field is internal-only — it must only be injected by the permission
  // system (SedEditPermissionRequest) after user approval. If the model supplies
  // it, the schema's strictObject should already reject it, but we strip here
  // as a safeguard against future regressions.
  let processedInput = resolvedInput
  if (
    tool.name === BASH_TOOL_NAME &&
    processedInput &&
    typeof processedInput === 'object' &&
    '_simulatedSedEdit' in processedInput
  ) {
    const { _simulatedSedEdit: _, ...rest } =
      processedInput as typeof processedInput & {
        _simulatedSedEdit: unknown
      }
    processedInput = rest as typeof processedInput
  }

  // Backfill legacy/derived fields on a shallow clone so hooks/canUseTool see
  // them without affecting tool.call(). SendMessageTool adds fields; file
  // tools overwrite file_path with expandPath — that mutation must not reach
  // call() because tool results embed the input path verbatim (e.g. "File
  // created successfully at: {path}"), and changing it alters the serialized
  // transcript and VCR fixture hashes. If a hook/permission later returns a
  // fresh updatedInput, callInput converges on it below — that replacement
  // is intentional and should reach call().
  let callInput = processedInput
  const backfilledClone =
    tool.backfillObservableInput &&
    typeof processedInput === 'object' &&
    processedInput !== null
      ? ({ ...processedInput } as typeof processedInput)
      : null
  if (backfilledClone) {
    tool.backfillObservableInput!(backfilledClone as Record<string, unknown>)
    processedInput = backfilledClone
  }

  // A call that stands for several calls of its tool — the batch Read — is
  // those calls to every hook: each runs once per unit, with the unit's own
  // input, and never with this call's (Tool.hookUnits, toolHooks.ts).
  const hookUnits = tool.hookUnits?.(callInput)

  let shouldPreventContinuation = false
  let stopReason: string | undefined
  let hookPermissionResult: PermissionResult | undefined
  const preToolHookInfos: StopHookInfo[] = []
  const preToolHookStart = Date.now()
  const preToolHooks = hookUnits
    ? runPreToolUseHooksForUnits(
        toolUseContext,
        tool,
        hookUnits,
        toolUseID,
        assistantMessage.message.id,
        requestId,
        mcpServerType,
        mcpServerBaseUrl,
      )
    : runPreToolUseHooks(
        toolUseContext,
        tool,
        processedInput,
        toolUseID,
        assistantMessage.message.id,
        requestId,
        mcpServerType,
        mcpServerBaseUrl,
      )
  for await (const result of preToolHooks) {
    switch (result.type) {
      case 'message':
        if (result.message.message.type === 'progress') {
          onToolProgress(result.message.message)
        } else {
          resultingMessages.push(result.message)
          const att = result.message.message.attachment
          if (
            att &&
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            preToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
        break
      case 'hookPermissionResult':
        hookPermissionResult = result.hookPermissionResult
        break
      case 'hookUpdatedInput':
        // Hook provided updatedInput without making a permission decision (passthrough)
        // Update processedInput so it's used in the normal permission flow
        processedInput = result.updatedInput
        break
      case 'preventContinuation':
        shouldPreventContinuation = result.shouldPreventContinuation
        break
      case 'stopReason':
        stopReason = result.stopReason
        break
      case 'additionalContext':
        resultingMessages.push(result.message)
        break
      case 'stop':
        getStatsStore()?.observe(
          'pre_tool_hook_duration_ms',
          Date.now() - preToolHookStart,
        )
        resultingMessages.push({
          message: createUserMessage({
            content: [createToolResultStopMessage(toolUseID)],
            toolUseResult: `Error: ${stopReason}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        })
        return resultingMessages
    }
  }
  const preToolHookDurationMs = Date.now() - preToolHookStart
  getStatsStore()?.observe('pre_tool_hook_duration_ms', preToolHookDurationMs)
  if (preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
    logForDebugging(
      `Slow PreToolUse hooks: ${preToolHookDurationMs}ms for ${tool.name} (${preToolHookInfos.length} hooks)`,
      { level: 'info' },
    )
  }

  // Check whether we have permission to use the tool,
  // and ask the user for permission if we don't
  const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
  const permissionStart = Date.now()

  const resolved = await resolveHookPermissionDecision(
    hookPermissionResult,
    tool,
    processedInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    toolUseID,
  )
  const permissionDecision = resolved.decision
  processedInput = resolved.input
  const permissionDurationMs = Date.now() - permissionStart
  // In auto mode, canUseTool awaits the classifier (side_query) — if that's
  // slow the collapsed view shows "Running…" with no (Ns) tick since
  // bash_progress hasn't started yet. Auto-only: in default mode this timer
  // includes interactive-dialog wait (user think time), which is just noise.
  if (
    permissionDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS &&
    permissionMode === 'auto'
  ) {
    logForDebugging(
      `Slow permission decision: ${permissionDurationMs}ms for ${tool.name} ` +
        `(mode=${permissionMode}, behavior=${permissionDecision.behavior})`,
      { level: 'info' },
    )
  }

  // Add message if permission was granted/denied by PermissionRequest hook
  if (
    permissionDecision.decisionReason?.type === 'hook' &&
    permissionDecision.decisionReason.hookName === 'PermissionRequest' &&
    permissionDecision.behavior !== 'ask'
  ) {
    resultingMessages.push({
      message: createAttachmentMessage({
        type: 'hook_permission_decision',
        decision: permissionDecision.behavior,
        toolUseID,
        hookEvent: 'PermissionRequest',
      }),
    })
  }

  if (permissionDecision.behavior !== 'allow') {
    logForDebugging(`${tool.name} tool permission denied`)

    let errorMessage = permissionDecision.message
    // Only use generic "Execution stopped" message if we don't have a detailed hook message
    if (shouldPreventContinuation && !errorMessage) {
      errorMessage = `Execution stopped by PreToolUse hook${stopReason ? `: ${stopReason}` : ''}`
    }

    // Build top-level content: tool_result (text-only for is_error compatibility) + images alongside
    const messageContent: ContentBlockParam[] = [
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ]

    // Add image blocks at top level (not inside tool_result, which rejects non-text with is_error)
    const rejectContentBlocks =
      permissionDecision.behavior === 'ask'
        ? permissionDecision.contentBlocks
        : undefined
    if (rejectContentBlocks?.length) {
      messageContent.push(...rejectContentBlocks)
    }

    // Generate sequential imagePasteIds so each image renders with a distinct label
    let rejectImageIds: number[] | undefined
    if (rejectContentBlocks?.length) {
      const imageCount = count(
        rejectContentBlocks,
        (b: ContentBlockParam) => b.type === 'image',
      )
      if (imageCount > 0) {
        const startId = getNextImagePasteId(toolUseContext.messages)
        rejectImageIds = Array.from(
          { length: imageCount },
          (_, i) => startId + i,
        )
      }
    }

    resultingMessages.push({
      message: createUserMessage({
        content: messageContent,
        imagePasteIds: rejectImageIds,
        toolUseResult: `Error: ${errorMessage}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    })

    // Run PermissionDenied hooks for auto mode classifier denials.
    // If a hook returns {retry: true}, tell the model it may retry.
    if (
      feature('TRANSCRIPT_CLASSIFIER') &&
      permissionDecision.decisionReason?.type === 'classifier' &&
      permissionDecision.decisionReason.classifier === 'auto-mode'
    ) {
      let hookSaysRetry = false
      for await (const result of executePermissionDeniedHooks(
        tool.name,
        toolUseID,
        processedInput,
        permissionDecision.decisionReason.reason ?? 'Permission denied',
        toolUseContext,
        permissionMode,
        toolUseContext.abortController.signal,
      )) {
        if (result.retry) hookSaysRetry = true
      }
      if (hookSaysRetry) {
        resultingMessages.push({
          message: createUserMessage({
            content:
              'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
            isMeta: true,
          }),
        })
      }
    }

    return resultingMessages
  }

  // Use the updated input from permissions if provided
  // (Don't overwrite if undefined - processedInput may have been modified by passthrough hooks)
  if (permissionDecision.updatedInput !== undefined) {
    processedInput = permissionDecision.updatedInput
  }

  // Kept for the cleanup in the finally block below, which removes this tool
  // call's decision entry from the per-turn map.
  const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)

  const startTime = Date.now()

  startSessionActivity('tool_exec')
  // If processedInput still points at the backfill clone, no hook/permission
  // replaced it — pass the pre-backfill callInput so call() sees the model's
  // original field values. Otherwise converge on the hook-supplied input.
  // Permission/hook flows may return a fresh object derived from the
  // backfilled clone (e.g. via inputSchema.parse). If its file_path matches
  // the backfill-expanded value, restore the model's original so the tool
  // result string embeds the path the model emitted — keeps transcript/VCR
  // hashes stable. Other hook modifications flow through unchanged.
  if (
    backfilledClone &&
    processedInput !== callInput &&
    typeof processedInput === 'object' &&
    processedInput !== null &&
    'file_path' in processedInput &&
    'file_path' in (callInput as Record<string, unknown>) &&
    (processedInput as Record<string, unknown>).file_path ===
      (backfilledClone as Record<string, unknown>).file_path
  ) {
    callInput = {
      ...processedInput,
      file_path: (callInput as Record<string, unknown>).file_path,
    } as typeof processedInput
  } else if (processedInput !== backfilledClone) {
    callInput = processedInput
  }
  // Asked once, after permission and before the call, so a lane's one-shot
  // memo is spent whether the command then succeeds or fails. Rendered now:
  // the note reads the transcript for tools already loaded, and the call does
  // not change it.
  const advice = askToolAdvice(tool, callInput, toolUseContext)
  const adviceNote = advice
    ? renderToolAdvice(advice, toolUseContext.options.tools, toolUseContext.messages ?? [])
    : null
  try {
    const result = await tool.call(
      callInput,
      {
        ...toolUseContext,
        toolUseId: toolUseID,
        userModified: permissionDecision.userModified ?? false,
      },
      canUseTool,
      assistantMessage,
      progress => {
        onToolProgress({
          toolUseID: progress.toolUseID,
          data: progress.data,
        })
      },
    )
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)
    const resultAdviceNote = adviceNoteAfterCall(tool, callInput, result.data, adviceNote)

    // Invalidate the local tool-result cache for any successful write. Reads
    // (Read/Glob/Grep/LSP) are populated by the buildTool wrapper; this side
    // clears stale entries when their underlying state changes.
    // Use callInput (the model's original path) rather than processedInput
    // (backfill-expanded) so the key matches what the Read/Glob/Grep cache
    // stored when the model called those tools with the same path string.
    invalidateCacheForWrite(tool.name, callInput as Record<string, unknown>)

    // Capture structured output from tool result if present
    if (typeof result === 'object' && 'structured_output' in result) {
      // Store the structured output in an attachment message
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'structured_output',
          data: result.structured_output,
        }),
      })
    }

    // Map the tool result to API format once and cache it. This block is reused
    // by addToolResult (skipping the remap).
    const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    )

    // Run PostToolUse hooks
    let toolOutput = result.data
    const hookResults = []
    const toolContextModifier = result.contextModifier
    const mcpMeta = result.mcpMeta

    async function addToolResult(
      toolUseResult: unknown,
      preMappedBlock?: ToolResultBlockParam,
    ) {
      // Use the pre-mapped block when available (non-MCP tools where hooks
      // don't modify the output), otherwise map from scratch.
      const toolResultBlock = preMappedBlock
        ? await processPreMappedToolResultBlock(preMappedBlock, tool, toolUseResult)
        : await processToolResultBlock(tool, toolUseResult, toolUseID)

      // Build content blocks - tool result first, then optional feedback
      const contentBlocks: ContentBlockParam[] = [
        withToolAdvice(
          withSerialEditHint(
            toolResultBlock,
            tool.name,
            toolUseContext,
            processedInput,
          ),
          resultAdviceNote,
        ),
      ]
      // Add accept feedback if user provided feedback when approving
      // (acceptFeedback only exists on PermissionAllowDecision, which is guaranteed here)
      if (
        'acceptFeedback' in permissionDecision &&
        permissionDecision.acceptFeedback
      ) {
        contentBlocks.push({
          type: 'text',
          text: permissionDecision.acceptFeedback,
        })
      }

      // Add content blocks (e.g., pasted images) from the permission decision
      const allowContentBlocks =
        'contentBlocks' in permissionDecision
          ? permissionDecision.contentBlocks
          : undefined
      if (allowContentBlocks?.length) {
        contentBlocks.push(...allowContentBlocks)
      }

      // Generate sequential imagePasteIds so each image renders with a distinct label
      let allowImageIds: number[] | undefined
      if (allowContentBlocks?.length) {
        const imageCount = count(
          allowContentBlocks,
          (b: ContentBlockParam) => b.type === 'image',
        )
        if (imageCount > 0) {
          const startId = getNextImagePasteId(toolUseContext.messages)
          allowImageIds = Array.from(
            { length: imageCount },
            (_, i) => startId + i,
          )
        }
      }

      resultingMessages.push({
        message: createUserMessage({
          content: contentBlocks,
          imagePasteIds: allowImageIds,
          toolUseResult:
            toolUseContext.agentId && !toolUseContext.preserveToolUseResults
              ? undefined
              : toolUseResult,
          mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
        contextModifier: toolContextModifier
          ? {
              toolUseID: toolUseID,
              modifyContext: toolContextModifier,
            }
          : undefined,
      })
    }

    // TOOD(hackyon): refactor so we don't have different experiences for MCP tools
    if (!isMcpTool(tool)) {
      await addToolResult(toolOutput, mappedToolResultBlock)
    }

    const postToolHookInfos: StopHookInfo[] = []
    const postToolHookStart = Date.now()
    const postToolHooks = hookUnits
      ? runPostToolUseHooksForUnits(
          toolUseContext,
          tool,
          toolUseID,
          assistantMessage.message.id,
          result.unitResults ?? [],
          requestId,
          mcpServerType,
          mcpServerBaseUrl,
        )
      : runPostToolUseHooks(
          toolUseContext,
          tool,
          toolUseID,
          assistantMessage.message.id,
          processedInput,
          toolOutput,
          requestId,
          mcpServerType,
          mcpServerBaseUrl,
        )
    for await (const hookResult of postToolHooks) {
      if ('updatedMCPToolOutput' in hookResult) {
        if (isMcpTool(tool)) {
          toolOutput = hookResult.updatedMCPToolOutput
        }
      } else if (isMcpTool(tool)) {
        hookResults.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
      } else {
        resultingMessages.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
      }
    }
    const postToolHookDurationMs = Date.now() - postToolHookStart
    if (postToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
      logForDebugging(
        `Slow PostToolUse hooks: ${postToolHookDurationMs}ms for ${tool.name} (${postToolHookInfos.length} hooks)`,
        { level: 'info' },
      )
    }

    if (isMcpTool(tool)) {
      await addToolResult(toolOutput)
    }

    // If the tool provided new messages, add them to the list to return.
    if (result.newMessages && result.newMessages.length > 0) {
      for (const message of result.newMessages) {
        resultingMessages.push({ message })
      }
    }
    // If hook indicated to prevent continuation after successful execution, yield a stop reason message
    if (shouldPreventContinuation) {
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'hook_stopped_continuation',
          message: stopReason || 'Execution stopped by hook',
          hookName: `PreToolUse:${tool.name}`,
          toolUseID: toolUseID,
          hookEvent: 'PreToolUse',
        }),
      })
    }

    // Yield the remaining hook results after the other messages are sent
    for (const hookResult of hookResults) {
      resultingMessages.push(hookResult)
    }
    return resultingMessages
  } catch (error) {
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)

    // Handle MCP auth errors by updating the client status to 'needs-auth'
    // This updates the /mcp display to show the server needs re-authorization
    if (error instanceof McpAuthError) {
      toolUseContext.setAppState(prevState => {
        const serverName = error.serverName
        const existingClientIndex = prevState.mcp.clients.findIndex(
          c => c.name === serverName,
        )
        if (existingClientIndex === -1) {
          return prevState
        }
        const existingClient = prevState.mcp.clients[existingClientIndex]
        // Only update if client was connected (don't overwrite other states)
        if (!existingClient || existingClient.type !== 'connected') {
          return prevState
        }
        const updatedClients = [...prevState.mcp.clients]
        updatedClients[existingClientIndex] = {
          name: serverName,
          type: 'needs-auth' as const,
          config: existingClient.config,
        }
        return {
          ...prevState,
          mcp: {
            ...prevState.mcp,
            clients: updatedClients,
          },
        }
      })
    }

    if (!(error instanceof AbortError)) {
      const errorMsg = errorMessage(error)
      logForDebugging(
        `${tool.name} tool error (${durationMs}ms): ${errorMsg.slice(0, 200)}`,
      )
      if (!(error instanceof ShellError)) {
        logError(error)
      }
    }
    const content = formatError(error)

    // Determine if this was a user interrupt
    const isInterrupt = error instanceof AbortError

    // Run PostToolUseFailure hooks
    const hookMessages: MessageUpdateLazy<
      AttachmentMessage | ProgressMessage<HookProgress>
    >[] = []
    // The units of the input that ran — a PreToolUse hook may have rewritten one.
    const failedUnits = hookUnits && (tool.hookUnits?.(callInput) ?? hookUnits)
    const failureHooks = failedUnits
      ? runPostToolUseFailureHooksForUnits(
          toolUseContext,
          tool,
          toolUseID,
          messageId,
          failedUnits,
          content,
          isInterrupt,
          requestId,
          mcpServerType,
          mcpServerBaseUrl,
        )
      : runPostToolUseFailureHooks(
          toolUseContext,
          tool,
          toolUseID,
          messageId,
          processedInput,
          content,
          isInterrupt,
          requestId,
          mcpServerType,
          mcpServerBaseUrl,
        )
    for await (const hookResult of failureHooks) {
      hookMessages.push(hookResult)
    }

    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: withRepeatedFailureHint(
                content,
                tool.name,
                input,
                toolUseContext,
                isInterrupt,
              ) + (isInterrupt || !adviceNote ? '' : adviceNote),
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `Error: ${content}`,
          mcpMeta: toolUseContext.agentId
            ? undefined
            : error instanceof
                McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
              ? error.mcpMeta
              : undefined,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
      ...hookMessages,
    ]
  } finally {
    stopSessionActivity('tool_exec')
    // Clean up this tool call's decision entry
    if (decisionInfo) {
      toolUseContext.toolDecisions?.delete(toolUseID)
    }
  }
}
