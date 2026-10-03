import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import z from 'zod/v4'
import { logForDebugging } from 'src/shared/debug.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from 'src/permissions/PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from 'src/permissions/PermissionUpdate.js'
import { permissionUpdateSchema } from 'src/permissions/PermissionUpdateSchema.js'

/** The question put to the permission prompt tool. */
export const inputSchema = lazySchema(() =>
  z.object({
    tool_name: z.string().describe('The tool asking for permission'),
    input: z.record(z.string(), z.unknown()).describe('The input of that tool call'),
    tool_use_id: z.string().optional().describe('The id of that tool call'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

/**
 * The answer comes from an SDK host or an MCP tool, so it is untrusted. An
 * optional part that does not parse is dropped, with a debug line, rather
 * than rejecting a decision that is otherwise well formed.
 */
function droppedWhenMalformed(field: string) {
  return ({ input }: { input: unknown }): undefined => {
    logForDebugging(
      `Permission prompt tool answer: dropped a malformed ${field}: ${String(JSON.stringify(input)).slice(0, 200)}`,
      { level: 'warn' },
    )
    return undefined
  }
}

const decisionClassificationSchema = lazySchema(() =>
  z
    .enum(['user_temporary', 'user_permanent', 'user_reject'])
    .optional()
    .catch(droppedWhenMalformed('decisionClassification')),
)

const allowAnswerSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
    updatedPermissions: z
      .array(permissionUpdateSchema())
      .optional()
      .catch(droppedWhenMalformed('updatedPermissions')),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationSchema(),
  }),
)

const denyAnswerSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationSchema(),
  }),
)

export const outputSchema = lazySchema(() =>
  z.union([allowAnswerSchema(), denyAnswerSchema()]),
)

export type Output = z.infer<ReturnType<typeof outputSchema>>

export function permissionPromptToolResultToPermissionDecision(
  result: Output,
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseContext: ToolUseContext,
): PermissionDecision {
  const decisionReason: PermissionDecisionReason = {
    type: 'permissionPromptTool',
    permissionPromptToolName: tool.name,
    toolResult: result,
  }

  if (result.behavior === 'deny') {
    if (result.interrupt === true) toolUseContext.abortController.abort()
    return { ...result, decisionReason }
  }

  const updates = result.updatedPermissions ?? []
  if (updates.length > 0) {
    toolUseContext.setAppState(state => ({
      ...state,
      toolPermissionContext: applyPermissionUpdates(state.toolPermissionContext, updates),
    }))
    persistPermissionUpdates(updates)
  }

  // An empty object means "run it as asked": a tool must never run with no
  // arguments because a host answered `{}`.
  const answeredInput = result.updatedInput
  const updatedInput = Object.keys(answeredInput).length === 0 ? input : answeredInput
  return { ...result, updatedInput, decisionReason }
}
