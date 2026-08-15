import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGitLog, type GitLogRow } from 'src/vcs/git/gitLog.js'

const PAGE = 50

export type GitLogState = {
  rows: GitLogRow[]
  loading: boolean
  hasMore: boolean
  /** Fetch the first page on first Log-tab activation (idempotent). */
  ensureLoaded: () => void
  /** Append the next page (called when scrolling near the bottom). */
  loadMore: () => void
  /** Re-fetch from the top (the `r` key). */
  refresh: () => void
}

/**
 * Lazy, paginated git-log rows for the Log tab. Nothing is fetched until
 * `ensureLoaded()` is called; `loadMore()` pages further back with `--skip`.
 */
export function useGitLog(cwd?: string): GitLogState {
  const [rows, setRows] = useState<GitLogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const startedRef = useRef(false)
  const loadingRef = useRef(false)
  // Monotonic token: every fetch claims the next id, and only the latest one is
  // allowed to apply its result. A repo switch / refresh starts a new fetch that
  // supersedes any in-flight one, so a stale page can never land for the wrong
  // repo (and can't leave `loadingRef` stuck — the winning fetch clears it).
  const reqIdRef = useRef(0)
  // Commit rows loaded so far — `--skip` counts commits, not graph lines.
  const commitCountRef = useRef(0)

  const fetchPage = useCallback(
    async (skip: number, append: boolean): Promise<void> => {
      const reqId = ++reqIdRef.current
      loadingRef.current = true
      setLoading(true)
      const batch = await fetchGitLog({ skip, limit: PAGE, cwd })
      // Superseded by a newer fetch (page change, refresh, or repo switch).
      if (reqId !== reqIdRef.current) return
      const commitCount = batch.filter(r => r.isCommit).length
      setRows(prev => (append ? [...prev, ...batch] : batch))
      commitCountRef.current = skip + commitCount
      setHasMore(commitCount >= PAGE)
      setLoading(false)
      loadingRef.current = false
    },
    [cwd],
  )

  // Reload from the top when the target repo changes (Log-tab project selector
  // in a monorepo). Skips the initial render — `cwdRef` starts equal to `cwd` —
  // so first load still goes through `ensureLoaded` on tab activation.
  const cwdRef = useRef(cwd)
  useEffect(() => {
    if (cwdRef.current === cwd) return
    cwdRef.current = cwd
    setRows([])
    setHasMore(true)
    commitCountRef.current = 0
    if (startedRef.current) void fetchPage(0, false)
  }, [cwd, fetchPage])

  const ensureLoaded = useCallback(() => {
    if (startedRef.current) return
    startedRef.current = true
    void fetchPage(0, false)
  }, [fetchPage])

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return
    void fetchPage(commitCountRef.current, true)
  }, [fetchPage, hasMore])

  const refresh = useCallback(() => {
    startedRef.current = true
    commitCountRef.current = 0
    void fetchPage(0, false)
  }, [fetchPage])

  return { rows, loading, hasMore, ensureLoaded, loadMore, refresh }
}
