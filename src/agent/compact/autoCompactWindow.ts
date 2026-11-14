// The window auto-compact sizes itself against, as configured. Claude Code's
// order: the env var wins, then the window /autocompact saved for this model
// under `modelSettings[<model>].autoCompactWindow`, then auto — the model's
// whole context window. getEffectiveContextWindowSize caps the model's window
// at whatever this returns.

import { getInitialSettings } from 'src/platform/settings/settings.js'

export const AUTO_COMPACT_WINDOW_ENV = 'CLAUDIN_AUTO_COMPACT_WINDOW'

export type ConfiguredAutoCompactWindow =
  | { source: 'env' | 'settings'; window: number }
  | { source: 'auto' }

/** `200000`, `200k`, `1.5m`: a token count, and whether it carried a suffix. Anything else is undefined. */
export function parseTokenCount(raw: string): { tokens: number; suffixed: boolean } | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(raw.trim().toLowerCase())
  if (!match) return undefined
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return { tokens: Math.round(parseFloat(match[1]!) * multiplier), suffixed: match[2] !== undefined }
}

// Unlike /autocompact, no 100k floor: a small local model needs a window below it.
function envAutoCompactWindow(): number | undefined {
  const raw = process.env[AUTO_COMPACT_WINDOW_ENV]
  if (!raw) return undefined
  const parsed = parseTokenCount(raw)
  return parsed && parsed.tokens > 0 ? parsed.tokens : undefined
}

function settingsAutoCompactWindow(model: string): number | undefined {
  const value = getInitialSettings().modelSettings?.[model]?.autoCompactWindow
  return typeof value === 'number' && value > 0 ? value : undefined
}

export function configuredAutoCompactWindow(model: string): ConfiguredAutoCompactWindow {
  const env = envAutoCompactWindow()
  if (env !== undefined) return { source: 'env', window: env }
  const saved = settingsAutoCompactWindow(model)
  if (saved !== undefined) return { source: 'settings', window: saved }
  return { source: 'auto' }
}
