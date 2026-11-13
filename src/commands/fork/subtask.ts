import { type ForkWording, runFork } from 'src/commands/fork/fork.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export const SUBTASK_WORDING: ForkWording = {
  usage: 'Usage: /subtask \\<task\\>',
  coordinator: 'Subtasks are not available in coordinator sessions. Use /branch instead.',
  noTurn: 'Cannot start a subtask before the first conversation turn',
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  return runFork(onDone, context, args, SUBTASK_WORDING)
}
