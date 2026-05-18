// Status/spinner row rendered in the scrollable area of the main REPL layout
// (extracted in Etapa 5 of ROADMAP 11e — see plan in
// `/home/viudes/.claudio/plans/starry-discovering-shannon.md`).
//
// Mirrors the original inline JSX from `REPL.tsx`:
//
//   <Box flexGrow={1} />
//   {showSpinner && <SpinnerWithVerb ... />}
//   {!showSpinner && !isLoading && ... && <BriefIdleStatus />}
//   {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
//
// Identity-critical refs (apiMetricsRef, responseLengthRef, loading/timing
// refs) are passed in as the SAME RefObject instances created in REPL —
// never recreated here. The component is intentionally a thin presentational
// shell: no state, no effects, no memoisation. The plan calls this out
// because SpinnerWithVerb reads these refs every frame for the elapsed
// timer, and a fresh ref would zero the clock on every render.
//
// React identity: a single React element wraps the three rows in a fragment
// so the parent layout's child-array length and order is unchanged.

import { Box } from '../../../ink.js'
import * as React from 'react'
import type { Theme } from 'src/utils/theme.js'
import { SpinnerWithVerb, BriefIdleStatus, type SpinnerMode } from '../../../components/Spinner.js'
import { PromptInputQueuedCommands } from '../../../components/PromptInput/PromptInputQueuedCommands.js'
import { isFullscreenEnvEnabled } from '../../../utils/fullscreen.js'

export type REPLStatusProps = {
  showSpinner: boolean
  streamMode: SpinnerMode
  spinnerTip?: string
  responseLengthRef: React.RefObject<number>
  // Loose shape: SpinnerWithVerb forwards this to its internal computeOtps
  // helpers; the canonical entry type lives in REPL.tsx where the ref is
  // created. Re-asserting it here would double the source of truth.
  apiMetricsRef: React.RefObject<unknown[]>
  spinnerMessage: string | null
  stopHookSpinnerSuffix: string | null
  verbose: boolean
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerColor: keyof Theme | null
  spinnerShimmerColor: keyof Theme | null
  hasActiveTools: boolean
  leaderIsIdle: boolean
  // BriefIdleStatus gating — kept as 5 boolean props instead of a single
  // composite so the parent's existing render guards stay readable.
  isLoading: boolean
  userInputOnProcessing: string | undefined
  hasRunningTeammates: boolean
  isBriefOnly: boolean
  viewedAgentTask: unknown
}

export function REPLStatus(props: REPLStatusProps): React.ReactNode {
  const {
    showSpinner,
    streamMode,
    spinnerTip,
    responseLengthRef,
    apiMetricsRef,
    spinnerMessage,
    stopHookSpinnerSuffix,
    verbose,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    spinnerColor,
    spinnerShimmerColor,
    hasActiveTools,
    leaderIsIdle,
    isLoading,
    userInputOnProcessing,
    hasRunningTeammates,
    isBriefOnly,
    viewedAgentTask,
  } = props
  return <>
    <Box flexGrow={1} />
    {showSpinner && <SpinnerWithVerb {...({
      mode: streamMode,
      spinnerTip,
      responseLengthRef,
      // apiMetricsRef is preserved for parity with the original REPL.tsx
      // call site (Etapa 5, ROADMAP 11e). Spinner's Props type does not
      // declare it — the prop is forwarded by spread to deeper helpers
      // that are tolerant of extra fields. The cast keeps the original
      // wire-through intact without re-typing Spinner.
      apiMetricsRef,
      overrideMessage: spinnerMessage,
      spinnerSuffix: stopHookSpinnerSuffix,
      verbose,
      loadingStartTimeRef,
      totalPausedMsRef,
      pauseStartTimeRef,
      overrideColor: spinnerColor,
      overrideShimmerColor: spinnerShimmerColor,
      hasActiveTools,
      leaderIsIdle,
    } as React.ComponentProps<typeof SpinnerWithVerb>)} />}
    {!showSpinner && !isLoading && !userInputOnProcessing && !hasRunningTeammates && isBriefOnly && !viewedAgentTask && <BriefIdleStatus />}
    {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
  </>
}
