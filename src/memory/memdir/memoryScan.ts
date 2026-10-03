/**
 * Memory-directory scanning primitives, kept free of the API-client chain so
 * extractMemories can import the scan without closing a cycle through
 * memdir.ts (#25372).
 */

import { join } from 'path'
import type { MemoryType } from 'src/memory/memdir/memoryTypes.js'
import { readMemoryHeader, toOneLine } from 'src/memory/memdir/memoryScan/readMemoryHeader.js'
import { walkMemoryDir } from 'src/memory/memdir/memoryScan/walkMemoryDir.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

async function headerOrNull(
  memoryDir: string,
  filename: string,
  signal: AbortSignal,
): Promise<MemoryHeader | null> {
  const filePath = join(memoryDir, filename)
  try {
    const head = await readMemoryHeader(filePath, FRONTMATTER_MAX_LINES, signal)
    return { filename, filePath, ...head }
  } catch {
    return null
  }
}

/** Never rejects: a listing that cannot be made, or is aborted, is empty. */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  if (signal.aborted) return []
  try {
    const filenames = await walkMemoryDir(memoryDir, signal)
    const headers = await Promise.all(filenames.map(name => headerOrNull(memoryDir, name, signal)))
    if (signal.aborted) return []
    return headers
      .filter((header): header is MemoryHeader => header !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

function manifestLine({ type, filename, mtimeMs, description }: MemoryHeader): string {
  const tag = type ? `[${type}] ` : ''
  const summary = description ? toOneLine(description) : ''
  const tail = summary ? `: ${summary}` : ''
  return `- ${tag}${filename} (${new Date(mtimeMs).toISOString()})${tail}`
}

export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories.map(manifestLine).join('\n')
}
