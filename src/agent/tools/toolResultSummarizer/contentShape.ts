import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

// ---------- shared guards (local to avoid import cycle into toolResultStorage) ----------

export function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    block =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

// String-only shim: the caller ensures content is a string, so the only
// "image" surface is a provider that pre-embedded a data URL in text —
// out of scope. Kept as an always-false stub so the guard site reads
// symmetrically with toolResultStorage.hasImageBlock on arrays.
export function hasImageContentBlock(_text: string): boolean {
  return false
}
