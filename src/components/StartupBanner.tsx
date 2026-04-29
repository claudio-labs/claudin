import React, { useMemo } from 'react'
import { Box, RawAnsi } from '../ink.js'
import { eagerParseCliFlag } from '../utils/cliArgs.js'
import { buildStartupBannerLines, STARTUP_BANNER_WIDTH } from './StartupScreen.js'

type Props = {
  /**
   * Optional --model flag override threaded through to provider detection.
   * When omitted, the component falls back to `eagerParseCliFlag('--model')`
   * so the rendered banner stays consistent with `printStartupScreen`.
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
  const lines = useMemo(() => {
    const override = modelOverride ?? eagerParseCliFlag('--model')
    return buildStartupBannerLines(override)
  }, [modelOverride])
  return (
    <Box flexDirection="column" flexShrink={0}>
      <RawAnsi lines={lines} width={STARTUP_BANNER_WIDTH} />
    </Box>
  )
}
