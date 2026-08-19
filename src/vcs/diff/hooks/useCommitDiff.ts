import type { StructuredPatchHunk } from 'diff'
import { useEffect, useState } from 'react'
import { fetchCommitDiff } from 'src/vcs/git/gitLog.js'

/**
 * Hunks for the selected commit, fetched only once `enabled` flips true — i.e.
 * when the user drills from the commit's file list into a file's diff. Moving
 * through the log therefore still costs one `--numstat` call per commit
 * (`useCommitFiles`) and never a full patch. `null` while the patch for the
 * current hash isn't loaded yet; the last commit's result is kept, so leaving
 * and re-entering the same commit's diff is instant.
 */
export function useCommitDiff(
  hash: string | null,
  cwd: string | undefined,
  enabled: boolean,
): Map<string, StructuredPatchHunk[]> | null {
  const [loaded, setLoaded] = useState<{
    hash: string
    hunks: Map<string, StructuredPatchHunk[]>
  } | null>(null)

  useEffect(() => {
    if (!enabled || !hash || loaded?.hash === hash) return
    let cancelled = false
    void fetchCommitDiff(hash, cwd).then(hunks => {
      if (!cancelled) setLoaded({ hash, hunks })
    })
    return () => {
      cancelled = true
    }
  }, [hash, cwd, enabled, loaded])

  return loaded?.hash === hash ? loaded.hunks : null
}
