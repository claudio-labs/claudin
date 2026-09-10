import { readdir } from 'fs/promises'
import { basename, sep } from 'path'

import type { MemoryHeader } from 'src/memory/memdir/memoryScan.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memdir.js'
import { MEMORY_TYPES } from 'src/memory/memdir/memoryTypes.js'
import { formatRelativeTimeAgo } from 'src/shared/text/format.js'

/**
 * Row building for the memory-directory browser, kept pure (no ink imports,
 * no path resolution against the live config) so it is unit-testable and so
 * MemoryFileSelector.tsx — which is React-Compiler output — only has to import
 * two constants from here.
 *
 * The one non-obvious rule lives in `isNestedEntry`: the team dir is a
 * SUBDIRECTORY of the private one (`<autoMemPath>/team/`, teamMemPaths.ts), and
 * scanMemoryFiles walks recursively, so a scan of the private dir also returns
 * every team memory. Browsing "private" must drop them, or the two lists are
 * the same list.
 */

/** Sentinel prefix on a selector row that opens the browser for a directory.
 *  Private: callers go through encodeBrowseValue/parseBrowseValue. */
const BROWSE_DIR_PREFIX = '__browse_dir__'

/** Sentinel value on the selector row that runs `/memory tidy`. */
export const TIDY_VALUE = '__memory_tidy__'

// A Select row's value is a string, so the browse row carries everything the
// browser needs — the title the selector already knew, and whether the dir is
// the shared one — rather than making the command re-derive them from a path
// (which would mean repeating MemoryFileSelector's feature('TEAMMEM') dance).
const BROWSE_FIELD_SEP = '\u001f'

export type BrowseTarget = {
  dir: string
  title: string
  isTeamDir: boolean
}

export function encodeBrowseValue(target: BrowseTarget): string {
  return `${BROWSE_DIR_PREFIX}${target.isTeamDir ? '1' : '0'}${BROWSE_FIELD_SEP}${target.title}${BROWSE_FIELD_SEP}${target.dir}`
}

/** Returns null for any value that is not a browse row. */
export function parseBrowseValue(value: string): BrowseTarget | null {
  if (!value.startsWith(BROWSE_DIR_PREFIX)) return null
  const rest = value.slice(BROWSE_DIR_PREFIX.length)
  const firstSep = rest.indexOf(BROWSE_FIELD_SEP)
  if (firstSep === -1) return null
  const secondSep = rest.indexOf(BROWSE_FIELD_SEP, firstSep + 1)
  if (secondSep === -1) return null
  // The dir takes the whole tail, so a path holding the separator still round
  // trips instead of being silently truncated.
  return {
    isTeamDir: rest.slice(0, firstSep) === '1',
    title: rest.slice(firstSep + 1, secondSep),
    dir: rest.slice(secondSep + 1),
  }
}

// Widest tag plus its brackets, plus the two-space gap before the name — so
// even `[reference]`, the longest, does not touch the name it labels.
const TYPE_TAG_WIDTH = Math.max(...MEMORY_TYPES.map(t => t.length)) + 4

export type MemoryDirRow = {
  label: string
  value: string
  description?: string
  /** The index row is pinned first and refuses deletion. */
  isIndex: boolean
}

/**
 * `[project]  ` padded to the widest tag so the name column lines up. A memory
 * with no `type:` in its frontmatter (legacy files parse to undefined) gets the
 * same width in blanks rather than shifting its row left.
 */
function typeTag(type: string | undefined): string {
  return (type === undefined ? '' : `[${type}]`).padEnd(TYPE_TAG_WIDTH)
}

/** True for a header that lives in a subdirectory of the scanned dir. */
function isNestedEntry(header: MemoryHeader): boolean {
  return header.filename.includes(sep) || header.filename.includes('/')
}

/**
 * Descriptions are written for recall, not for a list — this repo's run 100-200
 * characters, and Select's two-column layout wraps them, so six untrimmed rows
 * filled 25 lines of the dialog. Clipping here rather than at render time keeps
 * the filter honest: SearchableSelect matches on the description string it was
 * given, so what you can search stays what you can see.
 */
const DESCRIPTION_BUDGET = 60

function clipDescription(text: string | null): string | undefined {
  if (text === null) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= DESCRIPTION_BUDGET) return flat === '' ? undefined : flat
  return `${flat.slice(0, DESCRIPTION_BUDGET - 1).trimEnd()}…`
}

export function buildMemoryDirRows(
  headers: MemoryHeader[],
  options: { indexPath: string; indexExists: boolean; includeNested?: boolean },
): MemoryDirRow[] {
  const { indexPath, indexExists, includeNested = false } = options

  const rows: MemoryDirRow[] = []
  if (indexExists) {
    rows.push({
      label: `${''.padEnd(TYPE_TAG_WIDTH)}${basename(indexPath)}`,
      value: indexPath,
      description: 'the index loaded into context every session',
      isIndex: true,
    })
  }

  for (const header of headers) {
    if (!includeNested && isNestedEntry(header)) continue
    rows.push({
      label: `${typeTag(header.type)}${header.filename.replace(/\.md$/, '')}  ${formatRelativeTimeAgo(new Date(header.mtimeMs))}`,
      value: header.filePath,
      description: clipDescription(header.description),
      isIndex: false,
    })
  }

  return rows
}

// A markdown link target: `- [Title](file.md) — hook`. Captured rather than
// matched loosely because an index line may hold more than one link, and only
// the pointer target decides whether the line belongs to the deleted memory.
const INDEX_LINK_RE = /\]\(([^)]+)\)/

/**
 * Drops `filename`'s pointer line from a MEMORY.md index, leaving everything
 * else — headers, the intro blockquote, `## Section` groupings, and any link
 * pointing somewhere else — byte-identical. Returns the input unchanged when
 * there is no pointer, which is the common case for a memory the model wrote
 * without indexing.
 */
export function removeIndexPointer(
  indexContent: string,
  filename: string,
): string {
  const lines = indexContent.split('\n')
  const kept = lines.filter(line => {
    const match = INDEX_LINK_RE.exec(line)
    return match === null || match[1] !== filename
  })
  return kept.length === lines.length ? indexContent : kept.join('\n')
}

/**
 * How many memories a directory holds, for the selector row's `· N`. Counts
 * `.md` files at the top level only — no frontmatter read, since the main list
 * needs the number and nothing else — so the private dir's count excludes the
 * team subdirectory for free. Returns 0 for a directory that does not exist yet.
 */
export async function countMemoryFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(
      e => e.isFile() && e.name.endsWith('.md') && e.name !== ENTRYPOINT_NAME,
    ).length
  } catch {
    return 0
  }
}
