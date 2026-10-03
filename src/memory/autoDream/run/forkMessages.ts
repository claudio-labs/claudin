/**
 * What the dream reads off its fork's messages: one assistant message as a
 * turn of the task, and, once the fork is over, which of the files it named
 * were really written.
 *
 * Only Edit and Write calls count as writing a file. A write through a shell
 * or another tool goes unseen.
 */
import type { Message } from 'src/shared/types/message.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

export type DreamTurnReading = {
  /** The message's text blocks, one per line, trimmed. */
  readonly text: string
  readonly toolUseCount: number
  /** The memory files its Edit and Write calls name, in order. */
  readonly touchedPaths: string[]
}

type FileWriteCall = { readonly id: string; readonly filePath: string }

const WRITING_TOOLS: ReadonlySet<string> = new Set([FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME])

type Block = { readonly type?: unknown } & Record<string, unknown>

function blocksOf(message: Message): readonly Block[] {
  if (message.type !== 'assistant' && message.type !== 'user') return []
  const content: unknown = message.message.content
  return Array.isArray(content) ? (content as Block[]) : []
}

function fileWriteCalls(message: Message): FileWriteCall[] {
  if (message.type !== 'assistant') return []
  return blocksOf(message).flatMap(block => {
    if (block.type !== 'tool_use' || typeof block.name !== 'string' || !WRITING_TOOLS.has(block.name)) return []
    const input = block.input as { file_path?: unknown } | undefined
    const filePath = input?.file_path
    return typeof filePath === 'string' && typeof block.id === 'string' ? [{ id: block.id, filePath }] : []
  })
}

/** The turn an assistant message adds to the task; null for any other message. */
export function readDreamTurn(
  message: Message,
  isMemoryPath: (filePath: string) => boolean,
): DreamTurnReading | null {
  if (message.type !== 'assistant') return null
  const blocks = blocksOf(message)
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
  return {
    text,
    toolUseCount: blocks.filter(block => block.type === 'tool_use').length,
    touchedPaths: fileWriteCalls(message)
      .map(call => call.filePath)
      .filter(isMemoryPath),
  }
}

function failedCallIds(messages: readonly Message[]): Set<string> {
  const failed = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
        failed.add(block.tool_use_id)
      }
    }
  }
  return failed
}

/**
 * The touched paths that were written: a path drops out only when every Edit
 * or Write call naming it came back as an error.
 */
export function writtenPaths(touched: readonly string[], forkMessages: readonly Message[]): string[] {
  const failed = failedCallIds(forkMessages)
  const outcome = new Map<string, boolean>()
  for (const call of forkMessages.flatMap(fileWriteCalls)) {
    outcome.set(call.filePath, (outcome.get(call.filePath) ?? false) || !failed.has(call.id))
  }
  return touched.filter(path => outcome.get(path) !== false)
}
