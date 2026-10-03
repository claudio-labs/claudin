/**
 * The conversation of a listed session, read for the preview.
 */
import { useEffect, useState } from 'react'
import { isLiteLog, loadFullLog } from 'src/sessions/sessionStorage.js'
import { logError } from 'src/shared/log.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { formatRelativeTimeAgo } from 'src/shared/text/format.js'

export type SessionRead = { log: LogOption; loading: boolean }

type Landed = { entry: LogOption; result: LogOption }

/**
 * `entry` itself when it already carries its messages; otherwise the entry
 * read in full. Only the read of the current entry lands: a slower read of
 * an entry the preview has since been moved off is dropped.
 */
export function useSessionRead(
  entry: LogOption,
  read: (entry: LogOption) => Promise<LogOption> = loadFullLog,
): SessionRead {
  const needsRead = isLiteLog(entry)
  const [landed, setLanded] = useState<Landed | null>(null)

  useEffect(() => {
    if (!needsRead) return
    let current = true
    read(entry)
      .catch((error: unknown) => {
        logError(error)
        return entry
      })
      .then(result => {
        if (current) setLanded({ entry, result })
      })
    return () => {
      current = false
    }
  }, [entry, needsRead, read])

  if (!needsRead) return { log: entry, loading: false }
  if (landed?.entry === entry) return { log: landed.result, loading: false }
  return { log: entry, loading: true }
}

/** `<age> · <n> messages`, then ` · <branch>` when the session has one. */
export function previewFooter(log: LogOption, now: Date = new Date()): string {
  const parts = [formatRelativeTimeAgo(log.modified, { now }), `${log.messageCount} messages`]
  if (log.gitBranch) parts.push(log.gitBranch)
  return parts.join(' · ')
}
