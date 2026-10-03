/**
 * The sessions the startup picker lists: those of this repository's
 * worktrees, or those of every project, read a page at a time.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  enrichLogs,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogsProgressive,
  type SessionLogResult,
} from 'src/sessions/sessionStorage.js'
import { logError } from 'src/shared/log.js'
import type { LogOption } from 'src/shared/types/logs.js'

type SessionListScope = 'repository' | 'everywhere'

export type SessionList = {
  logs: LogOption[]
  /** True until the current scope's first page has arrived. */
  loading: boolean
  scope: SessionListScope
  toggleScope: () => void
  /** Reads the current scope again from its first page. */
  reload: () => void
  /** Appends up to `count` more sessions, if any remain. */
  loadMore: (count: number) => void
}

/** Where the next page starts in the full stat-only listing. */
type PageCursor = { listing: LogOption[]; next: number }

function firstPage(scope: SessionListScope, worktreePaths: string[]): Promise<SessionLogResult> {
  return scope === 'everywhere'
    ? loadAllProjectsMessageLogsProgressive()
    : loadSameRepoMessageLogsProgressive(worktreePaths)
}

export function useSessionList(worktreePaths: string[]): SessionList {
  const [scope, setScope] = useState<SessionListScope>('repository')
  const [logs, setLogs] = useState<LogOption[]>([])
  const [loading, setLoading] = useState(true)
  const cursor = useRef<PageCursor>({ listing: [], next: 0 })
  // Every first-page load starts a new generation; a result from an older one is dropped.
  const generation = useRef(0)
  const paging = useRef(false)
  // The caller may hand a new array with the same paths on every render.
  const pathsKey = worktreePaths.join('\0')
  const paths = useRef(worktreePaths)
  paths.current = worktreePaths

  const load = useCallback(
    async (target: SessionListScope) => {
      const mine = ++generation.current
      paging.current = false
      setLoading(true)
      try {
        const page = await firstPage(target, paths.current)
        if (mine !== generation.current) return
        cursor.current = { listing: page.allStatLogs, next: page.nextIndex }
        setLogs(page.logs)
      } catch (error) {
        logError(error)
        if (mine === generation.current) setLogs([])
      } finally {
        if (mine === generation.current) setLoading(false)
      }
    },
    // pathsKey stands for the paths themselves, which are read through the ref.
    [pathsKey],
  )

  useEffect(() => {
    void load(scope)
  }, [scope, load])

  const reload = useCallback(() => void load(scope), [load, scope])

  const toggleScope = useCallback(() => {
    setScope(current => (current === 'repository' ? 'everywhere' : 'repository'))
  }, [])

  const loadMore = useCallback((count: number) => {
    const { listing, next } = cursor.current
    if (paging.current || next >= listing.length) return
    const mine = generation.current
    paging.current = true
    // enrichLogs keeps reading past unlistable sessions until it has `count` or reaches the end.
    enrichLogs(listing, next, count)
      .then(page => {
        if (mine !== generation.current) return
        cursor.current = { listing, next: page.nextIndex }
        setLogs(shown => [...shown, ...page.logs.map((log, offset) => ({ ...log, value: shown.length + offset }))])
      }, logError)
      .finally(() => {
        if (mine === generation.current) paging.current = false
      })
  }, [])

  return { logs, loading, scope, toggleScope, reload, loadMore }
}
