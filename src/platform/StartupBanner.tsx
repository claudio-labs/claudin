import React, { useEffect, useMemo, useState } from 'react'
import { Box, RawAnsi } from 'src/terminal/ink.js'
import { useMainLoopModel } from 'src/hooks/useMainLoopModel.js'
import { eagerParseCliFlag } from 'src/platform/cliArgs.js'
import { subscribeLatestVersion } from 'src/platform/install/latestVersionCache.js'
import {
  buildStartupBannerLines,
  resolveUpdateNotice,
  STARTUP_BANNER_WIDTH,
  type UpdateNotice,
} from 'src/platform/StartupScreen.js'

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
  // Re-resolve when the background `runStartupUpdateCheck` writes a fresh
  // cache (see `latestVersionCache.subscribeLatestVersion`). Without this,
  // a newly-discovered "version available" line would only appear on the
  // *next* CLI launch. The check is fire-and-forget and async, so the line
  // simply pops in once the npm view call lands — no UI blocking, no
  // re-mount, just a re-render of this leaf.
  const [notice, setNotice] = useState<UpdateNotice | undefined>(() =>
    resolveUpdateNotice(),
  )
  useEffect(() => {
    // Re-read at mount: the background `runStartupUpdateCheck` may have
    // landed between the render-time `useState(() => resolveUpdateNotice())`
    // call and this effect's commit, leaving the banner stuck on the
    // stale value until the *next* write. Resolving once here closes that
    // window without waiting for another notify.
    setNotice(resolveUpdateNotice())
    return subscribeLatestVersion(() => {
      setNotice(resolveUpdateNotice())
    })
  }, [])
  const lines = useMemo(() => {
    const override = modelOverride ?? eagerParseCliFlag('--model') ?? liveModel
    return buildStartupBannerLines(override, notice)
  }, [modelOverride, liveModel, notice])
  return (
    <Box flexDirection="column" flexShrink={0}>
      <RawAnsi lines={lines} width={STARTUP_BANNER_WIDTH} />
    </Box>
  )
}
