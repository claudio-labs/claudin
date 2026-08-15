import type { StructuredPatchHunk } from 'diff'
import { useCallback, useRef, useState } from 'react'
import {
  type CommitFile,
  fetchGitStashes,
  fetchStashDiff,
  fetchStashFiles,
  type StashEntry,
} from 'src/vcs/git/gitLog.js'

export type StashDetail = {
  files: CommitFile[]
  hunks: Map<string, StructuredPatchHunk[]>
}

export type GitStashesState = {
  entries: StashEntry[]
  /** Whether the stash list has been fetched at least once. */
  loaded: boolean
  /** Fetch the stash list on first stash-source selection (idempotent). */
  ensureLoaded: () => void
  /** Re-fetch the stash list from disk (the `r` key). */
  refresh: () => void
  /** Load one stash's files + diff hunks on demand. */
  loadStash: (ref: string) => Promise<StashDetail>
}

/**
 * Lazy stash sources for the Local Changes source selector. The list is
 * fetched only when `ensureLoaded()` is first called; per-stash files/hunks
 * load on demand via `loadStash`.
 */
export function useGitStashes(cwd?: string): GitStashesState {
  const [entries, setEntries] = useState<StashEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const startedRef = useRef(false)

  const ensureLoaded = useCallback(() => {
    if (startedRef.current) return
    startedRef.current = true
    void (async () => {
      const list = await fetchGitStashes(cwd)
      setEntries(list)
      setLoaded(true)
    })()
  }, [cwd])

  const refresh = useCallback(() => {
    startedRef.current = true
    void (async () => {
      const list = await fetchGitStashes(cwd)
      setEntries(list)
      setLoaded(true)
    })()
  }, [cwd])

  const loadStash = useCallback(
    async (ref: string): Promise<StashDetail> => {
      const [hunks, files] = await Promise.all([
        fetchStashDiff(ref, cwd),
        fetchStashFiles(ref, cwd),
      ])
      return { files, hunks }
    },
    [cwd],
  )

  return { entries, loaded, ensureLoaded, refresh, loadStash }
}
