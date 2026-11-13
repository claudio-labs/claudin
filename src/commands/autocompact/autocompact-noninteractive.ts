import { applyAutoCompactWindow, autoCompactStatusText } from 'src/commands/autocompact/setting.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export async function call(
  args: string,
  context: ToolUseContext,
  apply: typeof applyAutoCompactWindow = applyAutoCompactWindow,
): Promise<{ type: 'text'; value: string }> {
  const model = context.options.mainLoopModel
  const raw = args.trim()
  return {
    type: 'text',
    value: raw ? apply(raw, model) : autoCompactStatusText(model),
  }
}
