/**
 * Asking a tool what it thinks of a call. The tool only ever sees input its
 * own schema accepted; a check that fails counts as no opinion, while an
 * abort ends the decision.
 */
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { AbortError, isSdkApiUserAbortError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

export type ParsedInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false }

export function parseToolInput(
  tool: Tool,
  input: Record<string, unknown>,
): ParsedInput {
  const parsed = tool.inputSchema.safeParse(input)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

function isUserAbort(error: unknown): boolean {
  return error instanceof AbortError || isSdkApiUserAbortError(error)
}

function noOpinion(): PermissionResult {
  return { behavior: 'passthrough', message: '' }
}

export async function askTool(
  tool: Tool,
  parsed: ParsedInput,
  context: ToolUseContext,
): Promise<PermissionResult> {
  if (!parsed.ok) return noOpinion()
  try {
    return await tool.checkPermissions(parsed.value, context)
  } catch (error) {
    if (isUserAbort(error)) throw error
    logError(error)
    return noOpinion()
  }
}

/** Fails closed: unparseable input, or a check that throws, counts as a write. */
export function readsOnly(tool: Tool, parsed: ParsedInput): boolean {
  if (!parsed.ok) return false
  try {
    return tool.isReadOnly(parsed.value)
  } catch (error) {
    logError(error)
    return false
  }
}

/** The same context, except that the permission mode it reports is `mode`. */
export function contextShowingMode(
  context: ToolUseContext,
  mode: PermissionMode,
): ToolUseContext {
  return {
    ...context,
    getAppState() {
      const appState = context.getAppState()
      return {
        ...appState,
        toolPermissionContext: { ...appState.toolPermissionContext, mode },
      }
    },
  }
}
