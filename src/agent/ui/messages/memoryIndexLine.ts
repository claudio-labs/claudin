/**
 * Text for the `memory_index` attachment line. Kept out of
 * AttachmentMessage.tsx because anything importing `src/terminal/ink.js` is
 * unimportable under `bun test` (see .claudin/rules/testing.md), and this is
 * the part worth pinning.
 */
import type { MemoryIndexSummary } from 'src/agent/attachments/types.js'
import {
  MEMORY_SCOPES,
  memoryIndexLabel,
  type MemoryScope,
} from 'src/memory/memdir/memoryScopes.js'
import { plural } from 'src/shared/text/stringUtils.js'

/** A resumed transcript's `'auto'` is the private index. */
function scopeOf(index: MemoryIndexSummary): MemoryScope {
  return index.kind === 'auto' ? 'private' : index.kind
}

function clause(index: MemoryIndexSummary): string {
  const label = memoryIndexLabel(scopeOf(index))
  // A cut index reports both halves: what arrived, and what the file holds.
  // Otherwise the cap fires in silence — the warning truncateEntrypointContent
  // appends goes to the model, never to the screen.
  const entries =
    index.totalEntryCount > index.entryCount
      ? `${index.entryCount} of ${index.totalEntryCount} ${plural(index.totalEntryCount, 'entry', 'entries')}`
      : `${index.entryCount} ${plural(index.entryCount, 'entry', 'entries')}`
  return `${label} (${entries})`
}

/**
 * The index clause: "global memories index (4 entries), private memories
 * index (16 entries), team memories index (121 entries)", or "… team
 * memories index (96 of 121 entries)" when a cap cut one of them short. It
 * names the INDEX on purpose: the
 * MEMORY.md files are what enter context every session, and "Loaded 16
 * memories" read as if the memory files themselves had — those load on
 * demand, when the model follows a pointer or a `paths:` match attaches one
 * (nested_memory).
 * Global, private, team — general to specific, as getMemoryFiles loads them.
 */
export function formatMemoryIndexCounts(
  indexes: readonly MemoryIndexSummary[],
): string {
  return [...indexes]
    .sort((a, b) => MEMORY_SCOPES.indexOf(scopeOf(a)) - MEMORY_SCOPES.indexOf(scopeOf(b)))
    .map(clause)
    .join(', ')
}

/** True when any index arrived shorter than the file on disk. */
export function hasTruncatedMemoryIndex(
  indexes: readonly MemoryIndexSummary[],
): boolean {
  return indexes.some(i => i.totalEntryCount > i.entryCount)
}
