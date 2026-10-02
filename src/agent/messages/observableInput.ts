import type { AssistantMessage } from 'src/shared/types/message.js'
import { findToolByName, type Tools } from 'src/tools/Tool.js'

/**
 * The assistant message an SDK consumer sees: tool_use inputs with the fields
 * each tool's backfillObservableInput ADDS (SendMessage's legacy type /
 * recipient / content). Inputs a backfill only overwrites stay as the model
 * wrote them — hooks get the expanded file_path from toolExecution.ts.
 *
 * Only the SDK output may carry this view. Every history the next request is
 * built from — the loop's own array, the REPL's, QueryEngine's, the transcript
 * a --resume reads — must keep the input the API saw: until 2026-10-01
 * query.ts yielded this clone to all of them, so the turn after a SendMessage
 * re-sent its tool_use with three more fields, and the server rewrote the
 * prefix from there and dropped the thinking after it
 * (src/agent/cache/loopPrefix.invariant.test.ts).
 *
 * Returns the same message when no tool added a field.
 */
export function withObservableToolInputs(
  message: AssistantMessage,
  tools: Tools,
): AssistantMessage {
  let clonedContent: AssistantMessage['message']['content'] | undefined
  for (let i = 0; i < message.message.content.length; i++) {
    const block = message.message.content[i]!
    if (block.type !== 'tool_use' || typeof block.input !== 'object' || block.input === null) {
      continue
    }
    const tool = findToolByName(tools, block.name)
    if (!tool?.backfillObservableInput) continue
    const originalInput = block.input as Record<string, unknown>
    const inputCopy = { ...originalInput }
    tool.backfillObservableInput(inputCopy)
    if (Object.keys(inputCopy).some(k => !(k in originalInput))) {
      clonedContent ??= [...message.message.content]
      clonedContent[i] = { ...block, input: inputCopy }
    }
  }
  return clonedContent
    ? { ...message, message: { ...message.message, content: clonedContent } }
    : message
}
