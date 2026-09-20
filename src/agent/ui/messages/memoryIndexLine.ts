/**
 * Text for the `memory_index` attachment line. Kept out of
 * AttachmentMessage.tsx because anything importing `src/terminal/ink.js` is
 * unimportable under `bun test` (see .claudin/rules/testing.md), and this is
 * the part worth pinning.
 */
import type { MemoryIndexSummary } from 'src/agent/attachments/types.js'
import { plural } from 'src/shared/text/stringUtils.js'

const KIND_ORDER: Record<MemoryIndexSummary['kind'], number> = {
  auto: 0,
  team: 1,
}

function clause(index: MemoryIndexSummary): string {
  const noun = plural(index.entryCount, 'memory', 'memories')
  const label = index.kind === 'team' ? `team ${noun}` : noun
  // A cut index reports both halves: what arrived, and what the file holds.
  // Otherwise the cap fires in silence — the warning truncateEntrypointContent
  // appends goes to the model, never to the screen.
  return index.totalEntryCount > index.entryCount
    ? `${index.entryCount} of ${index.totalEntryCount} ${label}`
    : `${index.entryCount} ${label}`
}

/**
 * The counts clause: "16 memories, 121 team memories", or
 * "16 memories, 96 of 121 team memories" when a cap cut one of them short.
 * Private always precedes team, whatever order getMemoryFiles returned.
 */
export function formatMemoryIndexCounts(
  indexes: readonly MemoryIndexSummary[],
): string {
  return [...indexes]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .map(clause)
    .join(', ')
}

/** True when any index arrived shorter than the file on disk. */
export function hasTruncatedMemoryIndex(
  indexes: readonly MemoryIndexSummary[],
): boolean {
  return indexes.some(i => i.totalEntryCount > i.entryCount)
}
