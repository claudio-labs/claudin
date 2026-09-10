import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Box, RawAnsi } from 'src/terminal/ink.js'
import { useMainLoopModel } from 'src/agent/hooks/useMainLoopModel.js'
import { eagerParseCliFlag } from 'src/platform/cliArgs.js'
import { subscribeLatestVersion } from 'src/platform/install/latestVersionCache.js'
import {
  buildStartupBannerLines,
  resolveUpdateNotice,
  shouldLatchStartupBanner,
  STARTUP_BANNER_WIDTH,
  type UpdateNotice,
} from 'src/platform/StartupScreen.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { useTerminalViewport } from 'src/terminal/ink/hooks/use-terminal-viewport.js'
import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js'

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
 * On the main screen it unmounts itself once it scrolls out of the viewport —
 * see the latch below. `CLAUDIN_KEEP_STARTUP_BANNER=1` turns that off and
 * keeps it in the frame for the whole session.
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
  // Once the banner has scrolled out of the terminal viewport it is in the
  // user's scrollback for good, and staying in the frame only gives a later
  // repaint something to resurrect — it is frame row 0, so a repaint of a
  // frame that fits the viewport starts on it. See shouldLatchStartupBanner
  // for why fullscreen is excluded and how /clear brings it back.
  //
  // isVisibleNow() falls back to its previous value (initially true) while
  // layout isn't ready, so this cannot fire before the first measurement. The
  // setState is one-shot — guarded by `hidden`, which never goes back to
  // false — so it cannot loop with the hook's own layout effect.
  const [ref, , isVisibleNow] = useTerminalViewport()
  const [hidden, setHidden] = useState(false)
  useLayoutEffect(() => {
    if (hidden) return
    if (
      shouldLatchStartupBanner({
        alreadyHidden: false,
        fullscreen: isFullscreenEnvEnabled(),
        keepBanner: isEnvTruthy(process.env.CLAUDIN_KEEP_STARTUP_BANNER),
        visible: isVisibleNow(),
      })
    ) {
      setHidden(true)
    }
  })
  if (hidden) {
    return null
  }
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      <RawAnsi lines={lines} width={STARTUP_BANNER_WIDTH} />
    </Box>
  )
}
