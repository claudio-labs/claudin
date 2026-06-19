import { basename } from 'path'
import { useCallback, useEffect, useState } from 'react'
import type { RepoGroup } from '../components/diff/types.js'
import {
  dedupeCanonicalRoots,
  findNestedGitRoots,
  getBranch,
} from '../utils/git.js'
import { fetchGitDiff, fetchGitDiffHunks } from '../utils/gitDiff.js'
import { gitDiffResultToFiles } from './useDiffData.js'

export type WorkspaceDiff = {
  groups: RepoGroup[]
  /** Effective roots actually diffed (explicit + discovered nested repos). */
  roots: string[]
  loading: boolean
  /** Re-fetch every root (the `r` key). */
  refresh: () => void
}

/**
 * Fetch working-tree diffs for every git root in scope, grouped per project:
 * the explicit `roots` (cwd repo + `/add-dir` workspace roots) plus any nested
 * child repos discovered under `scanBases` — the monorepo case where sibling
 * folders each have their own `.git`. A single root renders flat (no header)
 * via `groups.length === 1`; multiple roots get per-repo headers.
 */
export function useWorkspaceDiff(
  roots: string[],
  scanBases: string[],
): WorkspaceDiff {
  const [groups, setGroups] = useState<RepoGroup[]>([])
  const [effectiveRoots, setEffectiveRoots] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // Stable primitive deps so the effect re-runs only on a real change.
  const rootsKey = roots.join('\n')
  const basesKey = scanBases.join('\n')

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    async function load(): Promise<void> {
      const explicit = rootsKey ? rootsKey.split('\n') : []
      const bases = basesKey ? basesKey.split('\n') : []
      // Discover nested repos under each base, then order them after the
      // explicit roots (cwd repo stays first), sorted by name for stability.
      const discovered = (
        await Promise.all(bases.map(b => findNestedGitRoots(b)))
      ).flat()
      const nested = dedupeCanonicalRoots(discovered)
        .filter(r => !explicit.includes(r))
        .sort((a, b) => basename(a).localeCompare(basename(b)))
      const allRoots = dedupeCanonicalRoots([...explicit, ...nested])

      const results = await Promise.all(
        allRoots.map(async (root): Promise<RepoGroup> => {
          // Always pass the explicit root: each repo is diffed independently
          // and a root may not be the process cwd.
          const [result, hunks, branch] = await Promise.all([
            fetchGitDiff(root),
            fetchGitDiffHunks(root),
            getBranch(root),
          ])
          return {
            root,
            name: basename(root),
            branch,
            files: result ? gitDiffResultToFiles(result, hunks) : [],
            hunks,
          }
        }),
      )
      if (!cancelled) {
        setGroups(results)
        setEffectiveRoots(allRoots)
        setLoading(false)
      }
    }

    void load().catch(() => {
      if (!cancelled) {
        setGroups([])
        setEffectiveRoots([])
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [rootsKey, basesKey, nonce])

  const refresh = useCallback(() => setNonce(n => n + 1), [])

  return { groups, roots: effectiveRoots, loading, refresh }
}
