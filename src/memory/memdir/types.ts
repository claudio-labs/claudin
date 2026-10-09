import { feature } from 'bun:bundle'

export const MEMORY_TYPE_VALUES = [
  'User',
  'Project',
  'Local',
  'Managed',
  'AutoMem',
  'GlobalMem',
  ...(feature('TEAMMEM') ? (['TeamMem'] as const) : []),
] as const

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number]

/**
 * The auto-memory `MEMORY.md` indexes — global, private and team — as
 * opposed to the instruction files (CLAUDE.md, AGENTS.md, rules). They are
 * truncated at the index caps and announced as indexes, not instructions.
 */
export function isMemoryIndexType(type: MemoryType): boolean {
  return type === 'AutoMem' || type === 'GlobalMem' || type === 'TeamMem'
}
