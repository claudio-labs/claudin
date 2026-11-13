import type * as React from 'react'
import { AutoCompactDialog } from 'src/commands/autocompact/AutoCompactDialog.js'
import { applyAutoCompactWindow } from 'src/commands/autocompact/setting.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const model = context.options.mainLoopModel
  const raw = args?.trim() ?? ''
  if (raw) {
    onDone(applyAutoCompactWindow(raw, model))
    return null
  }
  return <AutoCompactDialog model={model} onDone={result => onDone(result)} />
}
