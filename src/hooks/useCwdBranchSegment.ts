import chalk from 'chalk'
import { useEffect, useState } from 'react'
import { useTheme } from 'src/components/design-system/ThemeProvider.js'
import { getCwd } from 'src/utils/cwd.js'
import {
  buildBranchBorderSegment,
  buildBranchPill,
  buildCwdPill,
  buildPrPill,
  resolveBranchBg,
  resolvePrBg,
} from 'src/utils/format-branch.js'
import { type PrReviewState } from 'src/utils/ghPrStatus.js'
import { getAheadBehind, getBranch } from 'src/utils/git.js'
import { getTheme } from 'src/utils/theme.js'
import { usePrStatus } from './usePrStatus.js'

export interface UseCwdBranchSegmentOptions {
  /** When a tool finishes (e.g. git push), trigger an immediate refresh. */
  isLoading?: boolean
  /** Skip polling entirely and return empty segments. Defaults to true. */
  enabled?: boolean
  /** Compute PR badge (number + review-state color) when available. */
  withPr?: boolean
}

export interface CwdBranchSegments {
  /** Standalone cwd pill `[ ~/path ►]`. */
  cwd: string
  /** Standalone branch pill `[◄ ⎇ branch (↑N) ►]`. Empty if no branch. */
  branch: string
  /** Standalone PR pill `[◄ PR #n ►]`. Empty if no PR or `withPr: false`. */
  pr: string
  /**
   * Legacy combined segment: cwd + branch + (PR text appended). Kept for
   * back-compat with callers (e.g. plan-mode sticky footer) that still want
   * the single pre-split rendering.
   */
  combined: string
}

const EMPTY_SEGMENTS: CwdBranchSegments = { cwd: '', branch: '', pr: '', combined: '' }

function colorizePrNumber(state: PrReviewState | null | undefined): (s: string) => string {
  switch (state) {
    case 'approved':
      return chalk.green
    case 'changes_requested':
      return chalk.red
    case 'pending':
      return chalk.yellow
    case 'merged':
      return chalk.magenta
    default:
      return chalk.dim
  }
}

/**
 * Returns the Powerline-style cwd / branch / PR segments used on the prompt
 * input border (and the plan-mode sticky footer via the `combined` field).
 *
 * Polls cwd/branch/ahead-behind every 2s (cache-hit fast path under getBranch);
 * PR status polled separately by `usePrStatus` only when `withPr` is true.
 *
 * Returns all-empty segments while disabled or before the first branch lookup
 * resolves — callers can use that to skip rendering and avoid a partial flash.
 */
export function useCwdBranchSegment(opts: UseCwdBranchSegmentOptions = {}): CwdBranchSegments {
  const { isLoading = false, enabled = true, withPr = false } = opts
  const cwd = getCwd()
  const [themeName] = useTheme()
  const [branch, setBranch] = useState<string>('')
  const [aheadBehind, setAheadBehind] = useState<{ ahead: number; behind: number }>({
    ahead: 0,
    behind: 0,
  })
  const pr = usePrStatus(isLoading, withPr && enabled)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const refresh = () => {
      getBranch()
        .then(b => {
          if (cancelled) return
          setBranch(prev => (prev === (b ?? '') ? prev : (b ?? '')))
        })
        .catch(() => {
          if (!cancelled) setBranch('')
        })
      getAheadBehind()
        .then(ab => {
          if (cancelled) return
          setAheadBehind(prev =>
            prev.ahead === ab.ahead && prev.behind === ab.behind ? prev : ab,
          )
        })
        .catch(() => {
          if (!cancelled) setAheadBehind({ ahead: 0, behind: 0 })
        })
    }

    refresh()
    const interval = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cwd, isLoading, enabled])

  if (!enabled) return EMPTY_SEGMENTS

  const home = process.env.HOME || ''
  const displayCwd =
    cwd === home ? '~' : home && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd
  const theme = getTheme(themeName)

  const prPill =
    withPr && branch && pr.number !== null && pr.url !== null
      ? buildPrPill(pr.number, pr.reviewState, theme, pr.label ?? 'PR', pr.url)
      : ''
  // When a branch pill follows, join the cwd's trailing arrow into the branch
  // pill's background (resolveBranchBg) so the two pills connect seamlessly;
  // likewise join the branch's trailing arrow into the PR pill's gray bg
  // (resolvePrBg) when present.
  const branchPill = buildBranchPill(
    branch,
    aheadBehind.ahead,
    aheadBehind.behind,
    theme,
    prPill ? resolvePrBg(theme) : undefined,
  )
  const cwdPill = buildCwdPill(displayCwd, theme, branchPill ? resolveBranchBg(theme) : undefined)

  let combined = buildBranchBorderSegment(
    displayCwd,
    branch,
    aheadBehind.ahead,
    aheadBehind.behind,
    theme,
  )
  if (withPr && pr.number !== null && pr.url !== null) {
    const colorize = colorizePrNumber(pr.reviewState)
    combined += '  ' + chalk.dim(pr.label ?? 'PR') + ' ' + colorize('#' + pr.number)
  }

  return { cwd: cwdPill, branch: branchPill, pr: prPill, combined }
}
