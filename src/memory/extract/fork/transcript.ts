/**
 * What the extraction reads off a transcript: the messages that are new since
 * the last extraction, whether the main agent already saved a memory among
 * them, and which memory files a fork actually saved.
 *
 * Only Edit and Write calls count as saving. A save through Patch,
 * NotebookEdit or a shell redirection goes unseen; recognizing a patch would
 * mean parsing the Patch tool's envelope here.
 */
import { basename } from 'path'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memdir.js'
import type { Message } from 'src/shared/types/message.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'

type FileWrite = { readonly toolUseId: string; readonly filePath: string }

/**
 * The messages after the one whose uuid is `mark`. All of them when there is
 * no mark yet, or when the marked message is gone, as after a compaction.
 */
export function messagesAfterMark(messages: readonly Message[], mark: string | undefined): readonly Message[] {
  const at = mark === undefined ? -1 : messages.findIndex(message => message.uuid === mark)
  return at === -1 ? messages : messages.slice(at + 1)
}

/** User and assistant messages; system, progress and attachment messages are not part of the exchange. */
export function countExchangeMessages(messages: readonly Message[]): number {
  return messages.filter(message => message.type === 'user' || message.type === 'assistant').length
}

function isFileWriteTool(name: string): boolean {
  return name === FILE_EDIT_TOOL_NAME || name === FILE_WRITE_TOOL_NAME
}

function filePathIn(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('file_path' in input)) return undefined
  return typeof input.file_path === 'string' ? input.file_path : undefined
}

/** The Edit and Write calls an assistant message makes that name a file. */
function fileWritesIn(message: Message): FileWrite[] {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return []
  const writes: FileWrite[] = []
  for (const block of message.message.content) {
    if (block.type !== 'tool_use' || !isFileWriteTool(block.name)) continue
    const filePath = filePathIn(block.input)
    if (filePath !== undefined) writes.push({ toolUseId: block.id, filePath })
  }
  return writes
}

/** The calls a user message answers with an error, a permission denial included. */
function failedToolUseIdsIn(message: Message): string[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) return []
  return message.message.content.flatMap(block =>
    block.type === 'tool_result' && block.is_error === true ? [block.tool_use_id] : [],
  )
}

/**
 * Whether the main agent saved a memory after the mark. A missing mark means
 * every message, as it does for the count of new messages: after a
 * compaction, a save among the surviving messages still counts.
 */
export function mainAgentSavedMemory(
  messages: readonly Message[],
  mark: string | undefined,
  isMemoryPath: (filePath: string) => boolean,
): boolean {
  return messagesAfterMark(messages, mark).some(message =>
    fileWritesIn(message).some(write => isMemoryPath(write.filePath)),
  )
}

/**
 * The memory files a fork saved, in the order it first saved them, each once:
 * the Edit and Write calls on a path inside the memory directory whose result
 * did not come back as an error. Indexes (`MEMORY.md` in any folder) are not
 * memories and are left out.
 */
export function savedMemoryFiles(
  forkMessages: readonly Message[],
  isMemoryPath: (filePath: string) => boolean,
): string[] {
  const failed = new Set(forkMessages.flatMap(failedToolUseIdsIn))
  const saved = new Set<string>()
  for (const message of forkMessages) {
    for (const { toolUseId, filePath } of fileWritesIn(message)) {
      if (failed.has(toolUseId) || !isMemoryPath(filePath) || basename(filePath) === ENTRYPOINT_NAME) continue
      saved.add(filePath)
    }
  }
  return [...saved]
}
