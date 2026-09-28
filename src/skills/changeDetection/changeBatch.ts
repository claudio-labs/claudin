/**
 * Changes gathered until the file system has been quiet for a while. Each
 * change starts the wait over, so a slow trickle still settles as one batch.
 */

/** The changed files of a settled batch, in the order they counted, each once. */
export type ChangedFiles = readonly [string, ...string[]]

export type ChangeBatch = {
  add: (path: string) => void
  /** Drops what is pending; nothing settles until the next change. */
  cancel: () => void
}

export function createChangeBatch(
  quietMs: number,
  onSettled: (changed: ChangedFiles) => void,
): ChangeBatch {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function settle(): void {
    timer = undefined
    const [first, ...rest] = pending
    pending.clear()
    if (first !== undefined) onSettled([first, ...rest])
  }

  function cancel(): void {
    clearTimeout(timer)
    timer = undefined
    pending.clear()
  }

  function add(path: string): void {
    pending.add(path)
    clearTimeout(timer)
    timer = setTimeout(settle, quietMs)
    // Like the watcher, a pending batch never keeps the process alive.
    timer.unref?.()
  }

  return { add, cancel }
}
