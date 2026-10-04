import { executePermissionRequestHooks } from 'src/platform/lifecycleHooks/hooks.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { PermissionRequestResult } from 'src/shared/types/hooks.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export type HookQuestion = {
  toolName: string
  toolUseID: string
  /** The call as made: hooks judge what the model asked for. */
  input: Record<string, unknown>
  toolUseContext: ToolUseContext
  mode: string | undefined
  suggestions: PermissionUpdate[] | undefined
}

/** The first allow or deny any PermissionRequest hook gives, or null. */
export async function askPermissionHooks(question: HookQuestion): Promise<PermissionRequestResult | null> {
  const results = executePermissionRequestHooks(
    question.toolName,
    question.toolUseID,
    question.input,
    question.toolUseContext,
    question.mode,
    question.suggestions,
    question.toolUseContext.abortController.signal,
  )
  for await (const result of results) {
    const verdict = result.permissionRequestResult
    if (verdict?.behavior === 'allow' || verdict?.behavior === 'deny') return verdict
  }
  return null
}
