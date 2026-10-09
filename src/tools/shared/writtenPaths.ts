import { expandPath } from 'src/shared/fs/path.js'

/*
 * Which files a tool use writes, read from its input's shape rather than its
 * tool's name, so an alias or a new write tool of the same shape reads the
 * same. Asked by everything that has to tell a write to memory from any
 * other call: the extraction's "the main agent already saved" check, the
 * memory count it notifies, the transcript badge, the format guard's index
 * scan.
 */

/** A Patch section's header: `*** Add File: <path>`, `*** Update File: <path>`, `*** Delete File: <path>`. */
export const PATCH_FILE_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/
/** The destination of the Update section above it: `*** Move to: <path>`. */
export const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/

const LINE_BREAK_RE = /\r?\n/

/**
 * The paths a patch's headers name, as written and in order: each Add,
 * Update and Delete, and each Move destination (its source is the Update
 * header above it). Header lines only — a patch that would not parse still
 * names what it meant to touch.
 */
export function patchHeaderPaths(patchText: string): string[] {
  const paths: string[] = []
  for (const line of patchText.split(LINE_BREAK_RE)) {
    const path = PATCH_FILE_HEADER_RE.exec(line)?.[2] ?? PATCH_MOVE_RE.exec(line)?.[1]
    if (path !== undefined && path.trim() !== '') paths.push(path.trim())
  }
  return paths
}

/**
 * The absolute paths a tool use writes, by its input's shape: a `patchText`
 * (Patch) writes every path its headers name — both sides of a move; a
 * `file_path` with `content` (Write) or `new_string` (Edit) writes that
 * path. A `file_path` alone is a read. A relative path resolves against
 * `cwd`, and `~` against home, as the write tools resolve them. Empty for
 * any other input.
 */
export function writtenPaths(input: unknown, cwd: string): string[] {
  if (typeof input !== 'object' || input === null) return []
  const fields = input as Record<string, unknown>
  const raw =
    typeof fields.patchText === 'string'
      ? patchHeaderPaths(fields.patchText)
      : typeof fields.file_path === 'string' &&
          (typeof fields.content === 'string' || typeof fields.new_string === 'string')
        ? [fields.file_path]
        : []
  // A path with a null byte is one expandPath refuses, and so does the tool.
  const paths = raw.filter(path => path.trim() !== '' && !path.includes('\0')).map(path => expandPath(path, cwd))
  return [...new Set(paths)]
}
