import { useMemo } from 'react'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { ToolPermissionContext, Tool as ToolType, ToolUseContext } from 'src/tools/Tool.js'
import type { AssistantMessage } from 'src/shared/types/message.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { createPermissionGate } from 'src/permissions/toolPermission/gate/router.js'

export type CanUseToolFn<Input extends Record<string, unknown> = Record<string, unknown>> = (tool: ToolType, input: Input, toolUseContext: ToolUseContext, assistantMessage: AssistantMessage, toolUseID: string, forceDecision?: PermissionDecision<Input>) => Promise<PermissionDecision<Input>>

/**
 * The REPL's permission gate, bound to the dialog queue and the session's
 * permission context. The function is the same for as long as both setters are.
 */
function useCanUseTool(
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>,
  setToolPermissionContext: (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => void,
): CanUseToolFn {
  return useMemo(
    () => createPermissionGate({ setToolUseConfirmQueue, setToolPermissionContext }),
    [setToolUseConfirmQueue, setToolPermissionContext],
  )
}

export default useCanUseTool
