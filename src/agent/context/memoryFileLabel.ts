import type { ContextData } from 'src/agent/context/analyzeContext.js'
import {
  MEMORY_SCOPE_SPECS,
  memoryIndexLabel,
  scopeOfMemoryType,
} from 'src/memory/memdir/memoryScopes.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { formatTokens } from 'src/shared/text/format.js'
import { plural } from 'src/shared/text/stringUtils.js'

type ContextMemoryFile = ContextData['memoryFiles'][number]

/**
 * How /context names a loaded memory file. An auto-memory index — global,
 * private, team — by what it is, as the session-start transcript line names
 * it, with its entry count and the /memory subcommand that browses, edits
 * and deletes what it points at; anything else (a CLAUDE.md, a rule) by its
 * path, as before. Pure, so both renderers (the panel and the
 * non-interactive table) share it and a test can pin it.
 */
export function describeContextMemoryFile(file: ContextMemoryFile): {
  /** The row's name: the index's, or the file's display path. */
  name: string
  /** What follows it: entries, tokens and the subcommand for an index; tokens otherwise. */
  detail: string
  /** The table's Type column: the index's name with its entries, or the raw memory type. */
  typeColumn: string
} {
  const tokens = `${formatTokens(file.tokens)} tokens`
  const scope = scopeOfMemoryType(file.type)
  if (scope === null) {
    return { name: getDisplayPath(file.path), detail: tokens, typeColumn: file.type }
  }
  const label = memoryIndexLabel(scope)
  const count = file.entryCount ?? 0
  const entries = `${count} ${plural(count, 'entry', 'entries')}`
  return {
    name: label,
    detail: `${entries} · ${tokens} · ${MEMORY_SCOPE_SPECS[scope].subcommand}`,
    typeColumn: `${label} (${entries})`,
  }
}
