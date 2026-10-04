import { useEffect } from 'react'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { CompletionType } from 'src/providers/transport/unaryLogging.js'
import { type AppState, useSetAppState } from 'src/terminal/state/AppState.js'

export type UnaryEvent = {
  completion_type: CompletionType
  language_name: string | Promise<string>
}

function countPrompt(state: AppState): AppState {
  return {
    ...state,
    attribution: { ...state.attribution, permissionPromptCount: state.attribution.permissionPromptCount + 1 },
  }
}

/**
 * Counts one permission prompt per tool use shown. The event argument is
 * still accepted because every dialog passes it; nothing reads it.
 */
export function usePermissionRequestLogging(toolUseConfirm: ToolUseConfirm, _unaryEvent: UnaryEvent): void {
  const setAppState = useSetAppState()
  const toolUseID = toolUseConfirm.toolUseID
  useEffect(() => {
    setAppState(countPrompt)
  }, [toolUseID, setAppState])
}
