import { useEffect, useState } from 'react'
import { type CommitFile, fetchCommitFiles } from 'src/vcs/git/gitLog.js'

const DEBOUNCE_MS = 150

/**
 * Debounced changed-files fetch for the selected Log-tab commit. Fetches `git
 * show --numstat` ~150ms after the selection settles (so holding ↓ through many
 * commits triggers one fetch, not one per row). `null` = loading, `[]` = none.
 */
export function useCommitFiles(
  hash: string | null,
  cwd?: string,
): CommitFile[] | null {
  const [files, setFiles] = useState<CommitFile[] | null>(null)

  useEffect(() => {
    if (!hash) {
      setFiles([])
      return
    }
    let cancelled = false
    setFiles(null) // loading
    const timer = setTimeout(() => {
      void fetchCommitFiles(hash, cwd).then(result => {
        if (!cancelled) setFiles(result)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hash, cwd])

  return files
}
