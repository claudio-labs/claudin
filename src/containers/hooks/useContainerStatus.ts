// Owns the docker events watcher for the session and folds its snapshots into
// AppState, where the footer's `containers` group renders them.
//
// Scaffolding is lifted from `src/vcs/hooks/usePrStatus.ts` — the other footer
// surface that shells out — for the same three reasons: stop after a long idle
// so an abandoned terminal holds no child, self-disable permanently when the
// tool is unusable rather than erroring every tick, and never re-run the effect
// on a turn boundary.
//
// Killswitch: CLAUDIN_DISABLE_CONTAINER_PANEL=1 removes the watcher and, with
// no rows ever registered, the footer group with it.

import { useEffect, useRef } from 'react'
import { getLastInteractionTime } from 'src/platform/bootstrap/state.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logForDebugging } from 'src/shared/debug.js'
import { useAppStateStore } from 'src/terminal/state/AppState.js'
import { applyContainerSnapshot } from 'src/agent/tasks/ContainerTask/ContainerTask.js'
import {
  isContainerPanelDisabled,
  startContainerWatcher,
  type ContainerWatcher,
} from 'src/containers/docker/eventsWatcher.js'
import { getContainersStartedByUs } from 'src/containers/startedByUs.js'

/** Stop watching after an hour with no interaction. Matches usePrStatus. */
const IDLE_STOP_MS = 60 * 60_000

/** How often the idle check runs. Cheap — no subprocess, just a clock read. */
const IDLE_CHECK_MS = 60_000

/**
 * Mount once, from the footer. Renders nothing and returns nothing: the rows
 * live in `AppState.tasks` like every other background task, so the tree, the
 * cursor and the `x` key work without this hook being in the picture.
 */
export function useContainerStatus(enabled = true): void {
  const store = useAppStateStore()
  const disabledRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    if (disabledRef.current) return
    if (isContainerPanelDisabled()) return

    const cwd = getCwd()
    let watcher: ContainerWatcher | null = null
    let idleTimer: NodeJS.Timeout | null = null

    watcher = startContainerWatcher({
      cwd,
      onSnapshot: containers => {
        applyContainerSnapshot(
          store.getState,
          store.setState,
          containers,
          getContainersStartedByUs(),
        )
      },
      onDisabled: message => {
        // Once, not once per tick: a machine without docker must cost one line
        // in the debug log and nothing else for the rest of the session.
        disabledRef.current = true
        logForDebugging(`container panel disabled: ${message}`)
      },
    })

    idleTimer = setInterval(() => {
      if (Date.now() - getLastInteractionTime() < IDLE_STOP_MS) return
      watcher?.stop()
      watcher = null
      if (idleTimer) {
        clearInterval(idleTimer)
        idleTimer = null
      }
    }, IDLE_CHECK_MS)

    return () => {
      if (idleTimer) clearInterval(idleTimer)
      watcher?.stop()
    }
    // cwd is read once on mount. A mid-session chdir (worktree enter/exit)
    // remounts the REPL, which is what re-runs this.
  }, [enabled, store])
}
