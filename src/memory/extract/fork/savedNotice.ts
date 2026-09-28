/**
 * The `memory_saved` system message an extraction announces its saves with.
 */
import { feature } from 'bun:bundle'
import { createMemorySavedMessage } from 'src/agent/messages/messages.js'
import type { SystemMemorySavedMessage } from 'src/shared/types/message.js'

/**
 * With team memory in the build, the message also says how many of the saved
 * files are team memories, and the renderer splits its line by that count.
 * The shared message type does not declare the field, so it is declared here.
 */
type MemorySavedNotice = SystemMemorySavedMessage & { teamCount?: number }

export function memorySavedNotice(
  writtenPaths: string[],
  isTeamMemoryFile: (filePath: string) => boolean,
): MemorySavedNotice {
  const notice = createMemorySavedMessage(writtenPaths)
  return feature('TEAMMEM')
    ? { ...notice, teamCount: writtenPaths.filter(path => isTeamMemoryFile(path)).length }
    : notice
}
