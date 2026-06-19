import type { Theme } from '../../utils/theme.js'

/**
 * Shared 8-entity palette for color-coding distinct things in the diff reviewer
 * (commit authors, repo groups). Drawn from the same theme tokens the subagent
 * UI uses, so it tracks the active theme.
 */
export const ENTITY_COLORS: readonly (keyof Theme)[] = [
  'cyan_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY',
  'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY',
  'blue_FOR_SUBAGENTS_ONLY',
  'red_FOR_SUBAGENTS_ONLY',
]

/** Deterministic name → palette color (same name, same color every time). */
export function entityColor(key: string): keyof Theme {
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  }
  return ENTITY_COLORS[Math.abs(h) % ENTITY_COLORS.length]!
}

/**
 * Palette color by position — guarantees the first N entities all differ
 * (used for repo group headers so siblings never share a color).
 */
export function entityColorByIndex(index: number): keyof Theme {
  const n = ENTITY_COLORS.length
  return ENTITY_COLORS[((index % n) + n) % n]!
}
