/**
 * Whether an end of turn starts a memory fork: a pure decision over what the
 * caller has read, in this order:
 *   1. the gates: a sub-agent's turn, the extraction switch, auto memory;
 *   2. a fork already running, which holds the turn for later;
 *   3. a memory the main agent saved since the last extraction;
 *   4. a turn held during a fork, which now follows it whatever the cadence;
 *   5. a repeated-error loop not yet acted on in this human turn;
 *   6. the cadence: every Nth turn that gets this far.
 * The transcript signals are read lazily, only once the turn gets that far.
 */
import type { LoopSignal } from 'src/memory/extract/loopDetector.js'

type ExtractionGate = 'subAgentTurn' | 'extractionOff' | 'autoMemoryOff'

export type GateReadings = {
  readonly subAgentTurn: boolean
  readonly extractionEnabled: boolean
  readonly autoMemoryEnabled: boolean
}

/** How an end of turn stands to a running fork. */
export type ForkOverlap =
  /** No fork is running. */
  | 'none'
  /** A fork is running: the turn is kept for later, and nothing starts. */
  | 'forkRunning'
  /** The turn was kept while a fork ran, and that fork has ended. */
  | 'trailing'

export type ForkDecision =
  | { readonly kind: 'fork'; readonly reason: 'routine' }
  | { readonly kind: 'fork'; readonly reason: 'loop'; readonly loop: LoopSignal }
  | { readonly kind: 'fork'; readonly reason: 'trailing' }

export type ExtractionDecision =
  | { readonly kind: 'gated'; readonly gate: ExtractionGate }
  | { readonly kind: 'held' }
  | { readonly kind: 'mainAgentSaved' }
  | { readonly kind: 'throttled'; readonly turnsCounted: number }
  | ForkDecision

/** The loops that already forced a fork, all from one human turn. */
export type FiredLoops = {
  readonly userTurnUuid: string | undefined
  readonly loopKeys: ReadonlySet<string>
}

export const NO_FIRED_LOOPS: FiredLoops = { userTurnUuid: undefined, loopKeys: new Set() }

export type TriggerInput = {
  readonly gates: GateReadings
  readonly overlap: ForkOverlap
  /** Turns counted toward the cadence since the last fork. */
  readonly turnsCounted: number
  /** The cadence: a fork on every Nth counted turn. */
  readonly interval: number
  readonly firedLoops: FiredLoops
  readonly mainAgentSaved: () => boolean
  /** The loudest repeated-error loop in the current human turn, if any. */
  readonly repeatedErrorLoop: () => LoopSignal | null
}

/** The first gate that keeps the turn out. There is no other: remote mode is not one. */
export function gateOf(readings: GateReadings): ExtractionGate | undefined {
  if (readings.subAgentTurn) return 'subAgentTurn'
  if (!readings.extractionEnabled) return 'extractionOff'
  if (!readings.autoMemoryEnabled) return 'autoMemoryOff'
  return undefined
}

/** A loop fires once per human turn; a new human turn, or a different loop, fires again. */
export function loopHasFired(fired: FiredLoops, loop: LoopSignal): boolean {
  return fired.userTurnUuid === loop.userTurnUuid && fired.loopKeys.has(loop.loopKey)
}

export function withFiredLoop(fired: FiredLoops, loop: LoopSignal): FiredLoops {
  const earlier = fired.userTurnUuid === loop.userTurnUuid ? fired.loopKeys : []
  return { userTurnUuid: loop.userTurnUuid, loopKeys: new Set([...earlier, loop.loopKey]) }
}

export function decideExtraction(input: TriggerInput): ExtractionDecision {
  const gate = gateOf(input.gates)
  if (gate !== undefined) return { kind: 'gated', gate }
  if (input.overlap === 'forkRunning') return { kind: 'held' }
  if (input.mainAgentSaved()) return { kind: 'mainAgentSaved' }
  if (input.overlap === 'trailing') return { kind: 'fork', reason: 'trailing' }
  const loop = input.repeatedErrorLoop()
  if (loop !== null && !loopHasFired(input.firedLoops, loop)) return { kind: 'fork', reason: 'loop', loop }
  const turnsCounted = input.turnsCounted + 1
  return turnsCounted >= input.interval
    ? { kind: 'fork', reason: 'routine' }
    : { kind: 'throttled', turnsCounted }
}
