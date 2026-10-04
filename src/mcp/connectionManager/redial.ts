import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { errorMessage } from 'src/shared/errors.js'
import type { ConnectionResult, RedialSchedule, ServerUpdate } from 'src/mcp/connectionManager/types.js'

const FIRST_WAIT_MS = 1_000
const LONGEST_WAIT_MS = 30_000

/** Five attempts; the waits double from 1 s (1, 2, 4, 8 s), capped at 30 s. */
const DEFAULT_REDIAL_SCHEDULE: RedialSchedule = {
  maxAttempts: 5,
  delayBeforeAttempt: attempt => Math.min(FIRST_WAIT_MS * 2 ** (attempt - 2), LONGEST_WAIT_MS),
}

/** Resolves true once `ms` have passed, false as soon as `signal` aborts. */
export type Wait = (ms: number, signal: AbortSignal) => Promise<boolean>

const timerWait: Wait = (ms, signal) =>
  new Promise(resolve => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export type RedialDeps = {
  dial: (name: string, config: ScopedMcpServerConfig) => Promise<ConnectionResult>
  /** Disabled on disk, or disconnected for the session. */
  shouldStop: (name: string) => boolean
  /** A `pending` attempt, or a stop. */
  report: (update: ServerUpdate) => void
  /** The attempt that ends the loop: the first that connects, or the last. */
  settle: (result: ConnectionResult) => void
  schedule?: RedialSchedule
  wait?: Wait
}

export type Redialer = {
  /** Replaces any loop already running for `name`; resolves when the loop ends. */
  start: (name: string, config: ScopedMcpServerConfig) => Promise<void>
  cancel: (name: string) => void
  isActive: (name: string) => boolean
  /** Ends every loop; later starts do nothing. */
  cancelAll: () => void
}

export function createRedialer(deps: RedialDeps): Redialer {
  const schedule = deps.schedule ?? DEFAULT_REDIAL_SCHEDULE
  const wait = deps.wait ?? timerWait
  const loops = new Map<string, AbortController>()
  let closed = false

  // The dial is not expected to throw (it reports `failed`), but a throw
  // still counts as a failed attempt rather than ending the loop.
  const attempt = async (name: string, config: ScopedMcpServerConfig): Promise<ConnectionResult> => {
    try {
      return await deps.dial(name, config)
    } catch (error) {
      return { client: { name, type: 'failed', config, error: errorMessage(error) }, tools: [], commands: [] }
    }
  }

  const run = async (name: string, config: ScopedMcpServerConfig, signal: AbortSignal) => {
    for (let n = 1; n <= schedule.maxAttempts; n++) {
      if (n > 1 && !(await wait(schedule.delayBeforeAttempt(n), signal))) return
      if (deps.shouldStop(name)) {
        deps.report({ name, type: 'disabled', config })
        return
      }
      deps.report({ name, type: 'pending', config, reconnectAttempt: n, maxReconnectAttempts: schedule.maxAttempts })
      const result = await attempt(name, config)
      if (signal.aborted) return
      if (result.client.type === 'connected' || n === schedule.maxAttempts) {
        deps.settle(result)
        return
      }
    }
  }

  const cancel = (name: string) => {
    loops.get(name)?.abort()
    loops.delete(name)
  }

  return {
    start: async (name, config) => {
      if (closed) return
      cancel(name)
      const controller = new AbortController()
      loops.set(name, controller)
      try {
        await run(name, config, controller.signal)
      } finally {
        if (loops.get(name) === controller) loops.delete(name)
      }
    },
    cancel,
    isActive: name => loops.has(name),
    cancelAll: () => {
      closed = true
      for (const name of [...loops.keys()]) cancel(name)
    },
  }
}
