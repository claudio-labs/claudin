import { parseFrontmatter } from 'src/shared/frontmatterParser.js'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { type MemoryType, parseMemoryType } from 'src/memory/memdir/memoryTypes.js'

export type MemoryFileHead = {
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

/** Collapses every whitespace run, line breaks included, so a value fits one manifest line. */
export function toOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * YAML hands the value through as written, so a description may be a number,
 * a boolean, a list or a block scalar spanning lines. Scalars become one line
 * of text; anything else, and an empty value, is no description.
 */
export function normalizeDescription(raw: unknown): string | null {
  const text =
    typeof raw === 'string' ? raw
    : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw)
    : ''
  return toOneLine(text) || null
}

/**
 * Reads only the first `headLines` lines, so frontmatter that has not closed
 * by then counts as absent. Rejects when the file cannot be read.
 */
export async function readMemoryHeader(
  filePath: string,
  headLines: number,
  signal: AbortSignal,
): Promise<MemoryFileHead> {
  const head = await readFileInRange(filePath, 0, headLines, undefined, signal)
  const { frontmatter } = parseFrontmatter(head.content, filePath)
  return {
    mtimeMs: head.mtimeMs,
    description: normalizeDescription(frontmatter.description),
    type: parseMemoryType(frontmatter.type),
  }
}
