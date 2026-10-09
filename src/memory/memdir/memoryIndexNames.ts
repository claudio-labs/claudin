import type { MemoryType } from 'src/memory/memdir/types.js'

/** The three auto-memory `MEMORY.md` indexes. */
export type MemoryIndexKind = 'global' | 'auto' | 'team'

/**
 * What each auto-memory index is called wherever the user sees it — the
 * session-start transcript line, /context — and the /memory subcommand that
 * opens its directory. "global", "private" and "team" are /memory's names
 * for the three directories (MemoryFileSelector.tsx); "user memory" there
 * already means ~/.claudin/CLAUDE.md, so it is free for none of them.
 */
export const MEMORY_INDEX_NAMES: Readonly<
  Record<MemoryIndexKind, { label: string; subcommand: string }>
> = {
  global: { label: 'global memories index', subcommand: '/memory global' },
  auto: { label: 'private memories index', subcommand: '/memory private' },
  team: { label: 'team memories index', subcommand: '/memory team' },
}

/** The index a memory file type is, or null for an instruction file. */
export function memoryIndexKind(
  type: MemoryType | string,
): MemoryIndexKind | null {
  switch (type) {
    case 'GlobalMem':
      return 'global'
    case 'AutoMem':
      return 'auto'
    case 'TeamMem':
      return 'team'
    default:
      return null
  }
}
