export const MEMORY_TYPE_VALUES = [
  'User',
  'Project',
  'Local',
  'Managed',
  'AutoMem',
  'GlobalMem',
  'TeamMem',
] as const

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number]
