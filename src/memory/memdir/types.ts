import { feature } from 'bun:bundle'

const INSTRUCTION_KINDS = ['User', 'Project', 'Local', 'Managed', 'AutoMem'] as const
const TEAM_KIND = 'TeamMem'

/**
 * The kind of instruction file the loader produces. Not the taxonomy of a
 * memory file, which is the `MemoryType` of memoryTypes.ts.
 */
export type MemoryType = (typeof INSTRUCTION_KINDS)[number] | typeof TEAM_KIND

export const MEMORY_TYPE_VALUES: readonly MemoryType[] = feature('TEAMMEM')
  ? [...INSTRUCTION_KINDS, TEAM_KIND]
  : INSTRUCTION_KINDS
