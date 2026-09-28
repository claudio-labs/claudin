import { readdirSync, readFileSync, type Dirent } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isENOENT } from 'src/shared/errors.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/entrypoint/limits.js'
import type { MemoryType } from 'src/memory/memdir/types.js'

const INDEX_KINDS: ReadonlySet<MemoryType> = new Set<MemoryType>([
  'AutoMem',
  'TeamMem',
])

/** Creates the directory and its parents; a failure is logged, never thrown. */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true })
  } catch (error) {
    logForDebugging(
      `Could not create memory directory ${memoryDir}: ${errorMessage(error)}`,
    )
  }
}

/**
 * The directory's `MEMORY.md`, or '' when it is missing or unreadable. The
 * path is joined, so a directory given without its separator still reads its
 * own index rather than a sibling file.
 */
export function readMemoryIndex(memoryDir: string): string {
  const indexPath = join(memoryDir, ENTRYPOINT_NAME)
  try {
    return readFileSync(indexPath, 'utf8')
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(
        `Could not read memory index ${indexPath}: ${errorMessage(error)}`,
      )
    }
    return ''
  }
}

/** A non-blank index, or any other `.md` file directly in the directory. */
export function hasExistingMemories(memoryDir: string): boolean {
  return readMemoryIndex(memoryDir).trim() !== '' || holdsTopicFile(memoryDir)
}

function holdsTopicFile(memoryDir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(memoryDir, { withFileTypes: true })
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(
        `Could not list memory directory ${memoryDir}: ${errorMessage(error)}`,
      )
    }
    return false
  }
  return entries.some(
    entry =>
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      entry.name !== ENTRYPOINT_NAME,
  )
}

/**
 * Judged on what the instruction loader put in context, so an empty-index note
 * agrees with what the model was actually given. An absent index has no entry.
 */
export function areMemoryIndexesEmpty(
  loaded: readonly Pick<MemoryFileInfo, 'type' | 'content'>[],
): boolean {
  return !loaded.some(
    file => INDEX_KINDS.has(file.type) && file.content.trim() !== '',
  )
}
