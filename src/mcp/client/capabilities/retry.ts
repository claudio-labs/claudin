import { sleep } from 'src/shared/sleep.js'

/** `tools/list` attempts, and the pause before each retry. */
export const TOOL_LIST_ATTEMPTS = 3
export const TOOL_LIST_RETRY_DELAYS_MS = [1_000, 2_000] as const

export type RetryDeps = {
  wait?: (ms: number) => Promise<void>
  onRetry?: (failedAttempt: number, error: unknown) => void
}

/**
 * Runs `task` until it succeeds or `attempts` are spent, pausing
 * `delaysMs[i]` (or the last delay) after the i-th failure. Rethrows the last
 * failure.
 */
export async function withRetries<T>(
  task: () => Promise<T>,
  attempts: number,
  delaysMs: readonly number[],
  deps: RetryDeps = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= attempts) throw error
      deps.onRetry?.(attempt, error)
      await (deps.wait ?? sleep)(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0)
    }
  }
}
