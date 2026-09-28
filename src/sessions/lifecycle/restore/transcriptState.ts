/**
 * The UI state a resumed session rebuilds from its transcript: the file
 * history and, while TodoWrite is the task tool, the todo list.
 */
import type {
  BetaContentBlock,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { z } from 'zod/v4'

import { isTodoV2Enabled } from 'src/agent/tasks/tasks.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { ResumedConversation } from 'src/sessions/lifecycle/restore/types.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { fileHistoryRestoreStateFromLog } from 'src/shared/fs/fileHistory.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { TODO_WRITE_TOOL_NAME } from 'src/tools/TodoWriteTool/constants.js'
import { type TodoList, TodoListSchema } from 'src/tools/TodoWriteTool/types.js'

/**
 * What a transcript carries for the UI. The attribution and context-collapse
 * entries are accepted from the callers, but this build restores neither.
 */
type TranscriptState = Partial<
  Pick<
    ResumedConversation,
    | 'messages'
    | 'fileHistorySnapshots'
    | 'attributionSnapshots'
    | 'contextCollapseCommits'
    | 'contextCollapseSnapshot'
  >
>

type SetAppState = (update: (prev: AppState) => AppState) => void

const TodoWriteInputSchema = lazySchema(() => z.object({ todos: TodoListSchema() }))

export function restoreSessionStateFromLog(
  transcript: TranscriptState,
  setAppState: SetAppState,
): void {
  const snapshots = transcript.fileHistorySnapshots
  if (snapshots && snapshots.length > 0) {
    fileHistoryRestoreStateFromLog(snapshots, fileHistory =>
      setAppState(prev => ({ ...prev, fileHistory })),
    )
  }
  const todos = todosToRestore(transcript.messages)
  if (todos) {
    const owner = getSessionId()
    setAppState(prev => ({ ...prev, todos: { ...prev.todos, [owner]: todos } }))
  }
}

function todosToRestore(messages: readonly Message[] | undefined): TodoList | undefined {
  // The v2 task list keeps its own store, and the model is not offered TodoWrite then.
  if (isTodoV2Enabled() || !messages || messages.length === 0) return undefined
  const parsed = TodoWriteInputSchema().safeParse(lastTodoWriteInput(messages))
  return parsed.success && parsed.data.todos.length > 0 ? parsed.data.todos : undefined
}

/**
 * The input of the TodoWrite call in the last assistant message that made one.
 * An earlier call never stands in for it, even when the last one is invalid.
 */
function lastTodoWriteInput(messages: readonly Message[]): unknown {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    const content: unknown = message.message.content
    if (!Array.isArray(content)) continue
    const call = (content as BetaContentBlock[]).findLast(isTodoWriteCall)
    if (call) return call.input
  }
  return undefined
}

function isTodoWriteCall(block: BetaContentBlock): block is BetaToolUseBlock {
  return block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME
}
