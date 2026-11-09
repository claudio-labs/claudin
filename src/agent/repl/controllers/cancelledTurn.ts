/**
 * Lets a turn cancelled with Esc finish yielding before the next turn appends
 * its prompt.
 *
 * onCancel frees the query guard at once (`queryGuard.forceEnd()`, REPL.tsx),
 * but the cancelled query is still unwinding: the tool it was running answers
 * its abort on its own schedule (WaitFor on its next poll), and query.ts then
 * yields that tool_result and the `[Request interrupted by user for tool use]`
 * marker. The queue processor, or a prompt typed straight away, starts the next
 * turn meanwhile. That turn was built from `[…, tool_use, prompt]` — a
 * placeholder result went out (ensureToolResultPairing) — and the late
 * messages landed in the REPL array after the prompt, so from the following
 * turn on the same message rendered other bytes: 660bb320 (2026-11-09) wrote
 * 138k again and lost 7 thinking blocks.
 *
 * So each turn registers its generation; a new turn waits, at most
 * CANCELLED_TURN_SETTLE_MS, for every older one still draining, and only then
 * appends. A turn that does not finish in time (a tool that ignores its abort)
 * is abandoned: what it yields afterwards is dropped, which is what the next
 * request already assumed.
 */

/** How long a new turn waits for a cancelled one to drain. */
export const CANCELLED_TURN_SETTLE_MS = 5_000

export type SettleOutcome = 'idle' | 'settled' | 'timedOut'

export type CancelledTurns = {
  /** Registers a turn that owns the query guard. */
  begin(generation: number): void
  /** Marks a turn drained. Idempotent; an unknown generation is a no-op. */
  end(generation: number): void
  /** Waits for every turn older than `generation` that has not drained. */
  settle(generation: number, timeoutMs?: number): Promise<SettleOutcome>
  /** True for a turn that was still draining when a newer one gave up on it. */
  isAbandoned(generation: number): boolean
}

export function createCancelledTurns(): CancelledTurns {
  const draining = new Map<number, { done: Promise<void>; resolve: () => void }>()
  const abandoned = new Set<number>()

  return {
    begin(generation) {
      if (draining.has(generation)) return
      let resolve!: () => void
      const done = new Promise<void>(r => {
        resolve = r
      })
      draining.set(generation, { done, resolve })
    },

    end(generation) {
      const turn = draining.get(generation)
      if (!turn) return
      draining.delete(generation)
      abandoned.delete(generation)
      turn.resolve()
    },

    async settle(generation, timeoutMs = CANCELLED_TURN_SETTLE_MS) {
      const older = [...draining].filter(([g]) => g < generation)
      if (older.length === 0) return 'idle'
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<true>(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      })
      const outcome = await Promise.race([
        Promise.all(older.map(([, turn]) => turn.done)).then(() => false as const),
        timedOut,
      ])
      clearTimeout(timer)
      if (!outcome) return 'settled'
      for (const [g] of older) {
        if (draining.has(g)) abandoned.add(g)
      }
      return 'timedOut'
    },

    isAbandoned(generation) {
      return abandoned.has(generation)
    },
  }
}
