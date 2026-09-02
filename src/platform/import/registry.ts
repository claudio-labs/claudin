/**
 * The one place that knows which foreign agents exist.
 *
 * Adding a ninth is an import and a row here; nothing else in the slice, and
 * nothing in `src/commands/import/`, has to learn its name. The order is the
 * order the user sees in the tree, so it is stable rather than alphabetical:
 * the two Claude-shaped forks first, then the rest by how much they carry.
 */
import {
  claudeAdapter,
  openclaudeAdapter,
} from 'src/platform/import/adapters/claudeLike.js'
import { codexAdapter } from 'src/platform/import/adapters/codex.js'
import { cursorAdapter } from 'src/platform/import/adapters/cursor.js'
import {
  geminiAdapter,
  qwenAdapter,
} from 'src/platform/import/adapters/geminiLike.js'
import { kimiAdapter } from 'src/platform/import/adapters/kimi.js'
import { opencodeAdapter } from 'src/platform/import/adapters/opencode.js'
import type {
  ForeignAgentAdapter,
  ForeignAgentId,
} from 'src/platform/import/types.js'

export const ADAPTERS: readonly ForeignAgentAdapter[] = [
  claudeAdapter,
  openclaudeAdapter,
  codexAdapter,
  geminiAdapter,
  qwenAdapter,
  opencodeAdapter,
  kimiAdapter,
  cursorAdapter,
]

export function getAdapter(id: ForeignAgentId): ForeignAgentAdapter | null {
  return ADAPTERS.find(adapter => adapter.id === id) ?? null
}

/** Every agent's display name, for the "looked for: …" message. */
export function allAgentLabels(): string[] {
  return ADAPTERS.map(adapter => adapter.label)
}
