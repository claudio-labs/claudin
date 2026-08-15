import { describe, expect, mock, test } from 'bun:test'

/**
 * Tests for CancelRequestHandler.handleInterrupt propagation logic.
 *
 * The key behavior under test: handleInterrupt must return `false` when it
 * has nothing to cancel, allowing the keypress event to propagate to the
 * double-press-to-exit handler (useExitOnCtrlCD). Without this, a stale
 * isCtrlCActive closure swallows the second Ctrl+C when React hasn't
 * re-rendered after the first Ctrl+C aborted the task.
 *
 * Since CancelRequestHandler is a React component with heavy dependencies,
 * we test the propagation logic in isolation rather than rendering the full
 * component. The core logic is:
 *
 * 1. If viewing a teammate → consume event (don't propagate)
 * 2. If a task is running or commands are queued → cancel and consume event
 * 3. If nothing to cancel → return false to propagate to exit handler
 */

// Reproduce the core handleInterrupt logic for isolated testing.
// This mirrors the logic in useCancelRequest.ts handleInterrupt.
function simulateHandleInterrupt(opts: {
  isViewingTeammate: boolean
  abortSignal?: AbortSignal
  hasCommandsInQueue: () => boolean
  handleCancel: () => void
  killAllAgentsAndNotify: () => void
  exitTeammateView: () => void
}): undefined | false {
  const {
    isViewingTeammate,
    abortSignal,
    hasCommandsInQueue,
    handleCancel,
    killAllAgentsAndNotify,
    exitTeammateView,
  } = opts

  if (isViewingTeammate) {
    killAllAgentsAndNotify()
    exitTeammateView()
    return undefined // consumed — teammate view handled it
  }

  // Read abortSignal.aborted and queue state fresh — not from stale closures
  const hasRunningTask = abortSignal !== undefined && !abortSignal.aborted
  const hasQueuedLive = hasCommandsInQueue()
  if (hasRunningTask || hasQueuedLive) {
    handleCancel()
    return undefined // consumed — cancelled a running task or popped a queued command
  }

  return false // nothing to cancel — propagate to double-press-to-exit
}

describe('handleInterrupt propagation', () => {
  test('returns false when nothing to cancel, allowing propagation to exit handler', () => {
    const handleCancel = mock(() => {})
    const killAll = mock(() => {})
    const exitTeammate = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: undefined,
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: killAll,
      exitTeammateView: exitTeammate,
    })

    expect(result).toBe(false)
    expect(handleCancel).not.toHaveBeenCalled()
    expect(killAll).not.toHaveBeenCalled()
    expect(exitTeammate).not.toHaveBeenCalled()
  })

  test('returns false when abort signal is already aborted (stale closure scenario)', () => {
    const handleCancel = mock(() => {})
    const controller = new AbortController()
    controller.abort() // Task was already cancelled by first Ctrl+C

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    // Signal is aborted — nothing to cancel, propagate to exit handler
    expect(result).toBe(false)
    expect(handleCancel).not.toHaveBeenCalled()
  })

  test('consumes event when task is running (first Ctrl+C)', () => {
    const handleCancel = mock(() => {})
    const controller = new AbortController() // Not aborted — task running

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    // Task is running — cancel it and consume the event
    expect(result).toBe(undefined) // void — event consumed
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })

  test('consumes event when queued commands exist', () => {
    const handleCancel = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: undefined,
      hasCommandsInQueue: () => true,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result).toBe(undefined) // void — event consumed
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })

  test('consumes event when viewing teammate', () => {
    const killAll = mock(() => {})
    const exitTeammate = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: true,
      abortSignal: undefined,
      hasCommandsInQueue: () => false,
      handleCancel: mock(() => {}),
      killAllAgentsAndNotify: killAll,
      exitTeammateView: exitTeammate,
    })

    expect(result).toBe(undefined) // void — event consumed
    expect(killAll).toHaveBeenCalledTimes(1)
    expect(exitTeammate).toHaveBeenCalledTimes(1)
  })

  test('fresh abortSignal.aborted read catches stale closure', () => {
    // Simulate the exact scenario: first Ctrl+C aborts the task,
    // React hasn't re-rendered yet (stale canCancelRunningTask=true),
    // but abortSignal.aborted is already true
    const controller = new AbortController()
    const handleCancel = mock(() => {})

    // First Ctrl+C: task is running
    const result1 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // signal.aborted === false
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result1).toBe(undefined) // consumed — first Ctrl+C cancelled the task
    expect(handleCancel).toHaveBeenCalledTimes(1)

    // Abort the task (simulating what handleCancel triggers)
    controller.abort()

    // Second Ctrl+C: stale closure would still have canCancelRunningTask=true,
    // but reading abortSignal.aborted fresh gives the correct state
    const result2 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // signal.aborted === true now
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    // Nothing to cancel — propagate to exit handler
    expect(result2).toBe(false)
    expect(handleCancel).toHaveBeenCalledTimes(1) // Not called again
  })

  // --- Additional edge-case scenarios ---

  test('viewing teammate takes priority over running task', () => {
    // When both isViewingTeammate and a running task are true,
    // teammate path should win and NOT call handleCancel
    const controller = new AbortController()
    const handleCancel = mock(() => {})
    const killAll = mock(() => {})
    const exitTeammate = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: true,
      abortSignal: controller.signal, // task is also running
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: killAll,
      exitTeammateView: exitTeammate,
    })

    expect(result).toBe(undefined) // consumed by teammate path
    expect(killAll).toHaveBeenCalledTimes(1)
    expect(exitTeammate).toHaveBeenCalledTimes(1)
    expect(handleCancel).not.toHaveBeenCalled() // teammate path wins
  })

  test('viewing teammate takes priority over queued commands', () => {
    const handleCancel = mock(() => {})
    const killAll = mock(() => {})
    const exitTeammate = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: true,
      abortSignal: undefined,
      hasCommandsInQueue: () => true,
      handleCancel,
      killAllAgentsAndNotify: killAll,
      exitTeammateView: exitTeammate,
    })

    expect(result).toBe(undefined)
    expect(killAll).toHaveBeenCalledTimes(1)
    expect(handleCancel).not.toHaveBeenCalled()
  })

  test('running task AND queued commands both cancel (single handleCancel)', () => {
    const controller = new AbortController()
    const handleCancel = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // running task
      hasCommandsInQueue: () => true, // also queued
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result).toBe(undefined) // consumed
    // handleCancel is called once — it handles both task abort and queue clear
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })

  test('aborted signal with queued commands still cancels (queue takes over)', () => {
    // Task was aborted but there are still queued commands to pop
    const controller = new AbortController()
    controller.abort()
    const handleCancel = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // aborted
      hasCommandsInQueue: () => true, // but queue has items
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result).toBe(undefined) // consumed — queue needs clearing
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })

  test('rapid triple Ctrl+C: task → aborted + queue → propagated', () => {
    // Simulates 3 rapid presses:
    // 1st: task running → cancel (consumed)
    // 2nd: task aborted, queue not yet cleared → cancel (consumed)
    // 3rd: task aborted, queue cleared → propagate to exit
    const controller = new AbortController()
    const handleCancel = mock(() => {})

    // 1st press: task running
    const result1 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => true,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })
    expect(result1).toBe(undefined) // consumed
    expect(handleCancel).toHaveBeenCalledTimes(1)

    // Task aborted after first press
    controller.abort()

    // 2nd press: task aborted but queue still draining
    const result2 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // aborted
      hasCommandsInQueue: () => true, // queue not yet cleared
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })
    expect(result2).toBe(undefined) // consumed — queue still active
    expect(handleCancel).toHaveBeenCalledTimes(2)

    // 3rd press: task aborted, queue cleared (React finally re-rendered)
    const result3 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal, // aborted
      hasCommandsInQueue: () => false, // queue cleared
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })
    expect(result3).toBe(false) // propagate to exit handler
    expect(handleCancel).toHaveBeenCalledTimes(2) // not called on 3rd press
  })

  test('no abortSignal at all (idle prompt) propagates immediately', () => {
    // When there's no signal and no queue, we're at an idle prompt.
    // The keypress should propagate to useExitOnCtrlCD for double-press exit.
    const handleCancel = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: undefined, // no task at all
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result).toBe(false)
    expect(handleCancel).not.toHaveBeenCalled()
  })

  test('abortSignal.aborted=true with no queue behaves like idle', () => {
    // After a task completes normally (not cancelled), the signal is aborted
    // but the controller reference may still be held by the component.
    // This should propagate, not consume.
    const controller = new AbortController()
    controller.abort() // task finished naturally
    const handleCancel = mock(() => {})

    const result = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => false,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })

    expect(result).toBe(false)
    expect(handleCancel).not.toHaveBeenCalled()
  })

  test('stale hasQueuedCommands closure does not swallow second Ctrl+C', () => {
    // Simulates: first Ctrl+C pops the last queued command, but React hasn't
    // re-rendered yet. The stale closure has hasQueuedCommands=true, but
    // hasCommandsInQueue() returns false (live read). Second Ctrl+C should
    // propagate to exit handler.
    const controller = new AbortController()
    controller.abort() // no running task
    const handleCancel = mock(() => {})
    let queueLength = 1 // mutable — simulates live queue state

    // First Ctrl+C: queue has 1 command
    const result1 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => queueLength > 0,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })
    expect(result1).toBe(undefined) // consumed — queue had items
    expect(handleCancel).toHaveBeenCalledTimes(1)

    // handleCancel popped the command
    queueLength = 0

    // Second Ctrl+C: stale closure would have hasQueuedCommands=true,
    // but live hasCommandsInQueue() returns false
    const result2 = simulateHandleInterrupt({
      isViewingTeammate: false,
      abortSignal: controller.signal,
      hasCommandsInQueue: () => queueLength > 0,
      handleCancel,
      killAllAgentsAndNotify: mock(() => {}),
      exitTeammateView: mock(() => {}),
    })
    expect(result2).toBe(false) // propagate to exit handler
    expect(handleCancel).toHaveBeenCalledTimes(1) // not called again
  })
})