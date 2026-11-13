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

function envAutoCompactWindow(): number | undefined {
  const raw = process.env[AUTO_COMPACT_WINDOW_ENV]
  if (!raw) return undefined
  const parsed = parseInt(raw, 10)
  return !isNaN(parsed) && parsed > 0 ? parsed : undefined
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
