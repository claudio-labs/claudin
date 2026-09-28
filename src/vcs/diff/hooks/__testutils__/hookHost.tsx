/**
 * Runs a React hook inside a real Ink root drawn on the project's fake
 * terminal, the way a dialog or the prompt footer runs it, and keeps every
 * value the hook returned, render by render.
 *
 * `rerender` hands the host new arguments, which is how a caller's props
 * change. `stop` unmounts the tree; `stopAll` is for an afterEach, so a test
 * that failed half-way leaves no hook (and none of its timers) behind.
 */
import React from 'react'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'

export type HookHost<A, R> = {
  /** What the hook returned on its most recent render. */
  current(): R
  /** Every value returned so far, oldest first. */
  readonly renders: readonly R[]
  rerender(args: A): void
  stop(): void
}

const running = new Set<() => void>()

export async function hostHook<A, R>(
  hook: (args: A) => R,
  args: A,
): Promise<HookHost<A, R>> {
  const terminal = createFakeTerminal({ columns: 100 })
  const root = await createRoot({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const renders: R[] = []

  function Carrier(props: { args: A }): React.ReactNode {
    renders.push(hook(props.args))
    return null
  }

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    running.delete(stop)
    root.unmount()
    terminal.close()
  }
  running.add(stop)
  root.render(<Carrier args={args} />)

  return {
    current: () => {
      if (renders.length === 0) throw new Error('the hook has not rendered yet')
      return renders[renders.length - 1] as R
    },
    renders,
    rerender: next => root.render(<Carrier args={next} />),
    stop,
  }
}

export function stopAllHooks(): void {
  for (const stop of [...running]) stop()
}

/** Polls `check` until it holds, or fails with `what` after `withinMs`. */
export async function until(
  what: string,
  check: () => boolean,
  withinMs = 3_000,
): Promise<void> {
  const deadline = performance.now() + withinMs
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out after ${withinMs} ms waiting for: ${what}`)
    }
    await Bun.sleep(5)
  }
}
