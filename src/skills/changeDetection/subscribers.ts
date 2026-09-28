/**
 * The detector's subscribers, each called on its own: one that throws, or
 * whose promise rejects, is reported, and the others are called all the same.
 */
import { createSignal } from 'src/shared/signal.js'

type Listener = () => void

type Subscribers = {
  /** Returns the function that removes the listener. */
  subscribe: (listener: Listener) => () => void
  notify: () => void
  clear: () => void
}

export function createSubscribers(reportError: (error: unknown) => void): Subscribers {
  const signal = createSignal()
  // One guard per listener for as long as the listener lives, so the signal's
  // set semantics carry over: a listener subscribed twice is called once, and
  // either unsubscribe removes it.
  const guards = new WeakMap<Listener, Listener>()

  function guarded(listener: Listener): Listener {
    let guard = guards.get(listener)
    if (guard === undefined) {
      guard = () => callAlone(listener, reportError)
      guards.set(listener, guard)
    }
    return guard
  }

  return {
    subscribe: listener => signal.subscribe(guarded(listener)),
    notify: () => signal.emit(),
    clear: () => signal.clear(),
  }
}

function callAlone(listener: Listener, reportError: (error: unknown) => void): void {
  try {
    const result: unknown = listener()
    // Typed `() => void`, a listener can still be async, as useSkillsChange's is.
    if (result instanceof Promise) result.catch(reportError)
  } catch (error) {
    reportError(error)
  }
}
