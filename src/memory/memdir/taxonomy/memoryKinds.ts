export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value)
}

/** A file without a valid `type:` still loads; it is just untyped. */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  return typeof raw === 'string' && isMemoryType(raw) ? raw : undefined
}
