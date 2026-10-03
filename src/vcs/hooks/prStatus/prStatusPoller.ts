import type { PrStatus } from 'src/vcs/git/ghPrStatus.js'

export type PollRules = {
  /** Between an answer and the next ask, and the least spacing between two asks. */
  intervalMs: number
  /** An answer slower than this is shown, and then the poller stops for good. */
  slowAnswerMs: number
  /** Wall-clock time without interaction after which timed asks stop. */
  idleStopMs: number
}

export type PrStatusPollerDeps = {
  ask: () => Promise<PrStatus | null>
  onAnswer: (answer: PrStatus | null) => void
  onError: (error: unknown) => void
  /** Durations and spacing; must not jump when the machine sleeps or the clock is set. */
  monotonicNow: () => number
  /** The idle rule; a sleeping machine counts as idle, so this one is the wall clock. */
  wallNow: () => number
  lastInteractionAt: () => number
  /** Runs `task` after `delayMs`; the returned function cancels it. */
  schedule: (task: () => void, delayMs: number) => () => void
}

/**
 * The clocks the pill runs on. `performance.now()` moves neither with a change
 * of the system clock nor across a suspend, so a sleeping machine never looks
 * like a slow answer (finding 8).
 */
export const SYSTEM_CLOCKS: Pick<PrStatusPollerDeps, 'monotonicNow' | 'wallNow'> = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
}

/**
 * Asks the code host for the branch's pull request on a fixed cadence. One
 * instance lives as long as the hook that owns it: `resume` is a re-run of the
 * hook's effect, `pause` its cleanup. An answer to an ask from before the
 * latest `resume` or `pause` is dropped.
 */
export class PrStatusPoller {
  private generation = 0
  private cancelPending: (() => void) | null = null
  private lastAnsweredAskStartedAt: number | null = null
  private interactionAtLastAsk: number | null = null
  private stoppedForSlowness = false

  constructor(
    private readonly rules: PollRules,
    private readonly deps: PrStatusPollerDeps,
  ) {}

  resume(): void {
    this.pause()
    if (this.stoppedForSlowness) return
    const generation = this.generation
    const since =
      this.lastAnsweredAskStartedAt === null
        ? Number.POSITIVE_INFINITY
        : this.deps.monotonicNow() - this.lastAnsweredAskStartedAt
    const wait = Math.max(0, this.rules.intervalMs - since)
    // The first ask of a restart is never judged idle: something just changed.
    if (wait === 0) this.ask(generation, false)
    else this.later(() => this.ask(generation, false), wait)
  }

  pause(): void {
    this.generation += 1
    this.cancelPending?.()
    this.cancelPending = null
  }

  private later(task: () => void, delayMs: number): void {
    this.cancelPending = this.deps.schedule(task, delayMs)
  }

  private ask(generation: number, mayBeIdle: boolean): void {
    if (generation !== this.generation) return
    this.cancelPending = null
    const interaction = this.deps.lastInteractionAt()
    if (mayBeIdle && this.isIdle(interaction)) return
    this.interactionAtLastAsk = interaction

    const startedAt = this.deps.monotonicNow()
    this.deps.ask().then(
      answer => this.answered(generation, startedAt, answer),
      (error: unknown) => {
        if (generation !== this.generation) return
        this.deps.onError(error)
        this.later(() => this.ask(generation, true), this.rules.intervalMs)
      },
    )
  }

  private answered(generation: number, startedAt: number, answer: PrStatus | null): void {
    if (generation !== this.generation) return
    const took = this.deps.monotonicNow() - startedAt
    this.lastAnsweredAskStartedAt = startedAt
    this.deps.onAnswer(answer)
    if (took > this.rules.slowAnswerMs) {
      this.stoppedForSlowness = true
      return
    }
    this.later(() => this.ask(generation, true), this.rules.intervalMs)
  }

  private isIdle(interaction: number): boolean {
    return (
      interaction === this.interactionAtLastAsk &&
      this.deps.wallNow() - interaction >= this.rules.idleStopMs
    )
  }
}
