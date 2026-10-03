/**
 * Which commit a new worktree starts from, as a plan the git shell carries
 * out: what to fetch from `origin` first, which ref to base on, and what to
 * fall back to when the fetch fails.
 */

export type BasePlan = {
  /** A refspec to fetch from `origin` before resolving `ref`, or null. */
  readonly fetch: string | null
  readonly ref: string
  /** Used when the fetch fails; null makes a failed fetch fatal. */
  readonly fallback: string | null
}

export type BaseSource =
  | { readonly kind: 'pull-request'; readonly prNumber: number }
  | { readonly kind: 'local-head' }
  | { readonly kind: 'default-branch' }

/** A pull request wins; then `baseRef: head`; otherwise the remote default branch. */
export function baseSourceFor(prNumber: number | undefined, baseRef: string | undefined): BaseSource {
  if (prNumber) return { kind: 'pull-request', prNumber }
  if (baseRef === 'head') return { kind: 'local-head' }
  return { kind: 'default-branch' }
}

export function pullRequestPlan(prNumber: number): BasePlan {
  return { fetch: `pull/${prNumber}/head`, ref: 'FETCH_HEAD', fallback: null }
}

export const LOCAL_HEAD_PLAN: BasePlan = { fetch: null, ref: 'HEAD', fallback: null }

/**
 * A remote-tracking ref already present is used however stale it is, so
 * creation stays offline; a missing one is fetched, and a fetch that fails
 * leaves the local HEAD.
 */
export function defaultBranchPlan(branch: string, presentLocally: boolean): BasePlan {
  const ref = `origin/${branch}`
  return presentLocally
    ? { fetch: null, ref, fallback: null }
    : { fetch: branch, ref, fallback: 'HEAD' }
}
