/**
 * Per-server mutex for LSP write operations.
 *
 * The QueryEngine serializes tool calls today, so concurrent invocations of
 * LSPTool are not the common case. But coordinator-mode workers can dispatch
 * tool calls in parallel against the same shared LSP server, and an
 * interleaved `rename` + `applyEdit` would leave the server's document
 * version state inconsistent. This module guards each server name with a
 * promise-chain mutex so any write op for the same server is fully ordered.
 *
 * Reads (which don't mutate server state) intentionally bypass the mutex —
 * applying it everywhere would slow down findReferences/hover/etc.
 */

const inFlight = new Map<string, Promise<unknown>>()

/**
 * Run `fn` with exclusive access to the named server. Concurrent callers for
 * the same name queue behind each other; different names run in parallel.
 *
 * Errors are propagated to the caller without leaving the mutex stuck.
 */
export async function withServerMutex<T>(
  serverName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = inFlight.get(serverName) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => {
    release = resolve
  })
  // Chain off `previous` so we don't start until the prior holder finishes.
  // Capture our entry into the map before the await so the next caller sees us.
  const ours = previous.then(() => next).catch(() => next)
  inFlight.set(serverName, ours)

  try {
    await previous
  } catch {
    // Prior holder failed; we still proceed.
  }
  try {
    return await fn()
  } finally {
    release()
    // If we're still the tail, clear the map entry so it doesn't grow.
    if (inFlight.get(serverName) === ours) {
      inFlight.delete(serverName)
    }
  }
}

/** Test-only: wipe pending entries. */
export function __resetServerMutexForTests(): void {
  inFlight.clear()
}
