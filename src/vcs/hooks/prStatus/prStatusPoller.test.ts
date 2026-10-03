/**
 * The poller's rules on a hand-driven clock pair: a monotonic one for the
 * duration of an ask and the spacing between asks, the wall clock for the idle
 * hour (spec, finding 8).
 */
import { describe, expect, setSystemTime, test } from 'bun:test'
import type { PrStatus } from 'src/vcs/git/ghPrStatus.js'
import { type PollRules, PrStatusPoller, SYSTEM_CLOCKS } from 'src/vcs/hooks/prStatus/prStatusPoller.js'

const RULES: PollRules = { intervalMs: 2_000, slowAnswerMs: 4_000, idleStopMs: 60 * 60_000 }
const HOUR = 60 * 60_000
const PR: PrStatus = { number: 7, url: 'https://forge.example/pull/7', reviewState: 'pending', label: 'PR' }

type Timer = { at: number; task: () => void; cancelled: boolean }

function rig() {
  const clock = { monotonic: 0, wall: 1_700_000_000_000, interaction: 1_700_000_000_000 }
  const timers: Timer[] = []
  const pending: Array<{ resolve: (answer: PrStatus | null) => void; reject: (error: Error) => void }> = []
  const answers: Array<PrStatus | null> = []
  const errors: unknown[] = []
  const poller = new PrStatusPoller(RULES, {
    ask: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onAnswer: answer => answers.push(answer),
    onError: error => errors.push(error),
    monotonicNow: () => clock.monotonic,
    wallNow: () => clock.wall,
    lastInteractionAt: () => clock.interaction,
    schedule: (task, delayMs) => {
      const timer = { at: clock.monotonic + delayMs, task, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })

  /** Moves both clocks (unless told otherwise) and runs the timers that came due. */
  function elapse(ms: number, wallMs = ms): void {
    clock.monotonic += ms
    clock.wall += wallMs
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= clock.monotonic) {
        timer.cancelled = true
        timer.task()
      }
    }
  }

  async function answerAsk(index: number, answer: PrStatus | null): Promise<void> {
    pending[index]!.resolve(answer)
    await Bun.sleep(0)
  }

  async function failAsk(index: number): Promise<void> {
    pending[index]!.reject(new Error('gh exploded'))
    await Bun.sleep(0)
  }

  return { clock, poller, pending, answers, errors, elapse, answerAsk, failAsk }
}

describe('durations and spacing use the monotonic clock (finding 8)', () => {
  test('the pill measures on a clock that a change of system time does not move', () => {
    const monotonicBefore = SYSTEM_CLOCKS.monotonicNow()
    try {
      setSystemTime(new Date(Date.now() + 3 * HOUR))
      expect(SYSTEM_CLOCKS.wallNow() - Date.now()).toBe(0)
      expect(SYSTEM_CLOCKS.monotonicNow() - monotonicBefore).toBeLessThan(HOUR)
    } finally {
      setSystemTime()
    }
  })

  test('a wall-clock jump during an ask (a suspended machine) is not a slow answer', async () => {
    const r = rig()
    r.poller.resume()
    r.elapse(100, HOUR * 3)
    await r.answerAsk(0, PR)
    // The timed ask after the sleep is skipped as idle, which is right: nobody was there.
    r.elapse(RULES.intervalMs, 0)
    expect(r.pending).toHaveLength(1)

    r.poller.resume()
    expect(r.pending).toHaveLength(2)
  })

  test('a wall clock set back does not delay the next ask', async () => {
    const r = rig()
    r.poller.resume()
    await r.answerAsk(0, PR)
    r.elapse(2_500, -HOUR)

    expect(r.pending).toHaveLength(2)
    r.poller.resume()
    expect(r.pending).toHaveLength(3)
  })

  const slowness = [
    { took: 4_001, asksAgain: false },
    { took: 4_000, asksAgain: true },
  ]
  for (const row of slowness) {
    test(`an answer after ${row.took} ms ${row.asksAgain ? 'keeps' : 'stops'} the polling`, async () => {
      const r = rig()
      r.poller.resume()
      r.elapse(row.took, 0)
      await r.answerAsk(0, PR)
      expect(r.answers).toEqual([PR])

      r.elapse(RULES.intervalMs)
      r.poller.resume()
      expect(r.pending.length > 1).toBe(row.asksAgain)
    })
  }
})

describe('the rest of the cadence', () => {
  test('a re-run soon after an ask waits out the interval from that ask', async () => {
    const r = rig()
    r.poller.resume()
    await r.answerAsk(0, PR)
    r.elapse(500)
    r.poller.resume()
    expect(r.pending).toHaveLength(1)
    r.elapse(1_499)
    expect(r.pending).toHaveLength(1)
    r.elapse(1)
    expect(r.pending).toHaveLength(2)
  })

  test('an hour without interaction stops it, exactly at the hour; a re-run asks at once', async () => {
    const r = rig()
    r.poller.resume()
    await r.answerAsk(0, PR)
    r.elapse(HOUR - 1, HOUR - 1)
    expect(r.pending).toHaveLength(2)
    await r.answerAsk(1, PR)

    // The timed ask comes due when the wall clock reads exactly an hour since the interaction.
    r.elapse(RULES.intervalMs, 1)
    expect(r.pending).toHaveLength(2)

    r.poller.resume()
    expect(r.pending).toHaveLength(3)
  })

  test('an interaction since the last ask keeps it asking past the hour', async () => {
    const r = rig()
    r.poller.resume()
    await r.answerAsk(0, PR)
    r.clock.wall += 2 * HOUR
    r.clock.interaction = r.clock.wall
    r.elapse(RULES.intervalMs)
    expect(r.pending).toHaveLength(2)
  })

  test('an interaction since the last ask counts even after a suspend longer than the hour', async () => {
    const r = rig()
    r.poller.resume()
    await r.answerAsk(0, PR)
    r.elapse(500)
    r.clock.interaction = r.clock.wall
    r.clock.wall += 2 * HOUR
    r.elapse(RULES.intervalMs, 0)
    expect(r.pending).toHaveLength(2)
  })

  test('an answer to an ask from before a re-run is dropped', async () => {
    const r = rig()
    r.poller.resume()
    r.poller.resume()
    expect(r.pending).toHaveLength(2)
    await r.answerAsk(0, { ...PR, number: 1 })
    await r.answerAsk(1, PR)
    expect(r.answers).toEqual([PR])
  })

  test('after a pause nothing is asked and a late answer is dropped', async () => {
    const r = rig()
    r.poller.resume()
    r.poller.pause()
    await r.answerAsk(0, PR)
    r.elapse(10 * RULES.intervalMs)
    expect(r.answers).toEqual([])
    expect(r.pending).toHaveLength(1)
  })

  test('a failed ask is reported and retried after the interval, without an answer', async () => {
    const r = rig()
    r.poller.resume()
    await r.failAsk(0)
    expect(r.errors).toHaveLength(1)
    expect(r.answers).toEqual([])
    r.elapse(RULES.intervalMs)
    expect(r.pending).toHaveLength(2)
  })
})
