// Owns the REPL's exit state machine.
//
// Extracted from src/screens/REPL.tsx (Etapa 2, ROADMAP 11e). Before extraction
// the exit handler lived in a 60-line inline `useCallback` with five sibling
// refs and a comment block explaining the state transitions. Lifting it into
// a dedicated hook keeps:
//   1. The state-machine docs adjacent to its only mutator.
//   2. The failsafe timer cleanup colocated with the timer itself.
//   3. The exit-flow React node managed by the same module that decides when
//      to show it (so REPL.tsx just renders `{exitFlow}`).
//
// State machine (preserved verbatim from the original):
//   idle      → requested : first press; arm 10s failsafe + run shutdown
//   requested → forced    : second press; SIGKILL immediately
//   requested → idle      : user backed out (worktree cancel, bg detach)
//   * → forced (timer)    : failsafe fired after 10s of stalled cleanup
//
// PromptInput's TextInput hook and useExitOnCtrlCDWithKeybindings both fire
// on the same Ctrl+C, so two synchronous calls land in the same tick. The
// FORCE_KILL_MIN_GAP_MS guard collapses same-press double dispatch — humans
// can't double-tap inside 250ms, and Ink's own double-press window is ~500ms.

import * as React from 'react'
import { useCallback, useRef, useState } from 'react'
import { spawnSync } from 'child_process'
import { feature } from 'bun:bundle'
import { isBgSession } from 'src/utils/concurrentSessions.js'
import { getCurrentWorktreeSession } from 'src/utils/worktree.js'
import { ExitFlow } from 'src/components/ExitFlow.js'
import exit from 'src/commands/exit/index.js'

type ExitState = 'idle' | 'requested' | 'forced'

const FORCE_KILL_MIN_GAP_MS = 250
const EXIT_FAILSAFE_MS = 10_000

export type UseReplExitResult = {
  /** Latest exit-flow React node (or `null` when not exiting). Render this. */
  exitFlow: React.ReactNode
  /** True between the first Ctrl+C and either completion or cancel. */
  isExiting: boolean
  /** Trigger the exit state machine. Safe to call from multiple Ctrl+C hooks. */
  handleExit: () => Promise<void>
}

export function useReplExit(): UseReplExitResult {
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null)
  const [isExiting, setIsExiting] = useState(false)
  const exitStateRef = useRef<ExitState>('idle')
  const exitRequestedAtRef = useRef(0)
  // Hard kill failsafe. gracefulShutdown has its own 5s failsafe but only runs
  // once it's actually called — and after long sessions we've seen the exit
  // path hang before reaching it (React render of ExitFlow stalls, the dynamic
  // exit.load() never resolves, etc.), leaving an unkillable REPL. Not
  // unref'd — if cleanup hangs we want the timer to fire; if it completes
  // gracefulShutdown's process.exit() terminates us before the timer matters.
  const exitFailsafeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearExitFailsafe = (): void => {
    if (exitFailsafeTimerRef.current) {
      clearTimeout(exitFailsafeTimerRef.current)
      exitFailsafeTimerRef.current = null
    }
  }

  const handleExit = useCallback(async () => {
    if (exitStateRef.current === 'forced') return
    if (exitStateRef.current === 'requested') {
      // Same-press double dispatch (two hooks, one keypress) — collapse.
      if (Date.now() - exitRequestedAtRef.current < FORCE_KILL_MIN_GAP_MS) return
      // Real second press while shutdown is in flight — user wants out NOW.
      exitStateRef.current = 'forced'
      clearExitFailsafe()
      process.kill(process.pid, 'SIGKILL')
      return
    }
    exitStateRef.current = 'requested'
    exitRequestedAtRef.current = Date.now()
    exitFailsafeTimerRef.current = setTimeout(() => {
      exitStateRef.current = 'forced'
      process.kill(process.pid, 'SIGKILL')
    }, EXIT_FAILSAFE_MS)
    setIsExiting(true)
    // In bg sessions, always detach instead of kill — even when a worktree is
    // active. Without this guard, the worktree branch below short-circuits into
    // ExitFlow (which calls gracefulShutdown) before exit.tsx is ever loaded.
    if (feature('BG_SESSIONS') && isBgSession()) {
      spawnSync('tmux', ['detach-client'], {
        stdio: 'ignore',
      })
      clearExitFailsafe()
      exitStateRef.current = 'idle'
      setIsExiting(false)
      return
    }
    const showWorktree = getCurrentWorktreeSession() !== null
    if (showWorktree) {
      setExitFlow(
        <ExitFlow
          showWorktree
          onDone={() => {}}
          onCancel={() => {
            setExitFlow(null)
            clearExitFailsafe()
            exitStateRef.current = 'idle'
            setIsExiting(false)
          }}
        />,
      )
      return
    }
    const exitMod = await exit.load()
    const exitFlowResult = await exitMod.call(() => {})
    setExitFlow(exitFlowResult)
    // If call() returned without killing the process (bg session detach),
    // clear isExiting so the UI is usable on reattach. No-op on the normal
    // path — gracefulShutdown's process.exit() means we never get here.
    if (exitFlowResult === null) {
      clearExitFailsafe()
      exitStateRef.current = 'idle'
      setIsExiting(false)
    }
  }, [])

  return { exitFlow, isExiting, handleExit }
}
