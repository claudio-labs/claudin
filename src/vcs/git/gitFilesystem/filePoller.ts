import { logError } from 'src/shared/log.js'

/** Starts watching `path` and calls `onChange` whenever it changes. Returns the stop. */
export type WatchFile = (path: string, onChange: () => void) => () => void

type Watcher = { path: string; stamp: string; onChange: () => void }

/**
 * Watches files by polling a stamp of each (see `fileStamp`), all on one
 * timer. The first stamp is taken when the watch starts, so a change made
 * after `watch` returns shows at the next poll, and a file that does not
 * exist yet is watched for its creation. The timer never keeps the process
 * alive.
 */
export function createFilePoller(intervalMs: number, stamp: (path: string) => string): WatchFile {
  const watchers = new Set<Watcher>()
  let timer: ReturnType<typeof setInterval> | undefined

  function poll(): void {
    for (const watcher of [...watchers]) {
      if (!watchers.has(watcher)) continue
      const current = stamp(watcher.path)
      if (current === watcher.stamp) continue
      watcher.stamp = current
      try {
        watcher.onChange()
      } catch (error) {
        logError(error)
      }
    }
  }

  return (path, onChange) => {
    const watcher: Watcher = { path, stamp: stamp(path), onChange }
    watchers.add(watcher)
    if (timer === undefined) {
      timer = setInterval(poll, intervalMs)
      timer.unref?.()
    }
    return () => {
      watchers.delete(watcher)
      if (watchers.size > 0 || timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
  }
}
