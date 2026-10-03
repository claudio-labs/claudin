/**
 * The mutable state behind the transcript writer's batched appends: what is
 * waiting per file, the timer that drains it, the chain that keeps drains
 * from overlapping, and the count `flush()` waits on. The behaviour lives in
 * `Project`; this only holds the state together.
 */
import type { Entry } from 'src/shared/types/logs.js'

/** How long a queued line waits for company before the drain runs. */
const DRAIN_DELAY_MS = 100

/** Largest text handed to one append, unless a single line is bigger. */
export const APPEND_CHUNK_LIMIT_BYTES = 100 * 1024 * 1024

/** One queued line and the settle of the call that queued it. */
export type QueuedLine = { entry: Entry; resolve: () => void }

export class QueueState {
  /** Lines waiting for the next drain, per destination file, in arrival order. */
  readonly linesByFile = new Map<string, QueuedLine[]>()
  /** The armed drain timer, or null when nothing is scheduled. */
  timer: ReturnType<typeof setTimeout> | null = null
  /** The last drain started; the next one runs after it settles. */
  drainChain: Promise<void> | null = null
  /** Tracked writes that have not finished yet. */
  inFlight = 0
  /** `flush()` callers waiting for `inFlight` to reach zero. */
  idleWaiters: Array<() => void> = []
  /** The delay in force; a remote mirror shortens it. */
  delayMs = DRAIN_DELAY_MS
}
