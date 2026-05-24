import React, { useMemo } from 'react'
import { Box, RawAnsi } from '../ink.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { eagerParseCliFlag } from '../utils/cliArgs.js'
import { readLatestVersion } from '../utils/latestVersionCache.js'
import { gt } from '../utils/semver.js'
import {
  buildStartupBannerLines,
  STARTUP_BANNER_WIDTH,
  type UpdateNotice,
} from './StartupScreen.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

function resolveUpdateNotice(): UpdateNotice | undefined {
  const cache = readLatestVersion()
  if (!cache) return undefined
  const current = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  if (!current) return undefined
  // Suppress when the cache was recorded against a different running version —
  // the user just updated and the cache hasn't been refreshed yet.
  if (cache.current !== current) return undefined
  try {
    if (!gt(cache.latest, current)) return undefined
  } catch {
    return undefined
  }
  return { latest: cache.latest }
}

type Props = {
  /**
   * Optional --model flag override threaded through to provider detection.
   * When omitted, the component falls back to the in-session `/model`
   * selection (AppState.mainLoopModelForSession ?? mainLoopModel) and
   * finally to `eagerParseCliFlag('--model')`, so the banner stays in sync
   * with what the agent loop actually uses.
   */
  modelOverride?: string
}

/**
 * Ink rendering of the startup banner. Mirrors `printStartupScreen` but lives
 * inside the React tree so the banner commits to the alternate-screen buffer
 * when flicker-free mode is on. Without this, `printStartupScreen` writes to
 * the main buffer BEFORE <AlternateScreen> mounts and the banner is stranded
 * in scrollback that the user can't see until they exit the REPL.
 *
 * Bypasses the <Ansi> roundtrip by going through <RawAnsi>: the lines are
 * already terminal-ready (ANSI escape codes inline, fixed width), so Yoga
 * sees a single leaf with constant-time measure.
 */
export function StartupBanner({ modelOverride }: Props): React.ReactNode {
  // Use the same resolution the agent loop uses (subscription default,
  // /model selection, session override, --model flag) so the banner stays
  // in sync. Without this, the banner would show the active provider
  // profile's `model` field, which can lag behind the effective default —
  // e.g. Max users get Opus by default but the profile may still hold the
  // "claude-sonnet-4-6" value from initial setup.
  const liveModel = useMainLoopModel()
  const lines = useMemo(() => {
    const override = modelOverride ?? eagerParseCliFlag('--model') ?? liveModel
    return buildStartupBannerLines(override, resolveUpdateNotice())
  }, [modelOverride, liveModel])
  return (
    <Box flexDirection="column" flexShrink={0}>
      <RawAnsi lines={lines} width={STARTUP_BANNER_WIDTH} />
    </Box>
  )
}
