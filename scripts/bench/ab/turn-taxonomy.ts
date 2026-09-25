#!/usr/bin/env bun
/**
 * What each model request of a session-cache A/B run was for, per arm — the
 * turn taxonomy of `turnTaxonomy.ts`: requests per label and per lever as
 * median [min–max] over reps, the lever sub-kinds, the REACT causes, and the
 * mechanism metrics the request-count A/B's gates read
 * (`.claudin/plans/synchronous-conjuring-creek.md`, "Verificação").
 * It reads transcripts only and spends nothing.
 *
 *   bun scripts/bench/ab/turn-taxonomy.ts <stamp> <arm,arm,...> [--listing]
 *
 *   bun scripts/bench/ab/turn-taxonomy.ts 231111 claudindev,placebo,catread,claude
 *   bun scripts/bench/ab/turn-taxonomy.ts 20260924-231111 claudindev,chain --listing
 *
 * <stamp> names the run under /tmp/session-cache-ab/, whole or by a unique
 * ending (`231111`). A claudin arm is read from
 * ~/.claudin/projects/-tmp-session-cache-ab-<stamp>-<arm>-r<N>/, the `claude`
 * arm from ~/.claude/projects/, and every rep found there is used.
 * --listing appends every session request by request: its label, the label
 * the REACT rule replaced, levers, notes and mechanism tags (chain-resp,
 * git-read+check, patch:src+test[+doc], commit-after-failure), then the
 * tools, `[ERR]` on a failed one and `[SKIPPED]` on one the same-response
 * guard refused.
 */
import { analyzeSession, loadSession, renderListing, renderReport, repsOf, stampsMatching, summarizeArm, type ArmSummary, type SessionResult } from './turnTaxonomy'

const USAGE = 'usage: bun scripts/bench/ab/turn-taxonomy.ts <stamp> <arm,arm,...> [--listing]'

function main(): void {
  const args = process.argv.slice(2)
  const listing = args.includes('--listing')
  const [run, armList, ...extra] = args.filter(a => a !== '--listing')
  if (!run || !armList || extra.length) {
    console.error(USAGE)
    process.exit(2)
  }
  const stamps = stampsMatching(run)
  if (stamps.length > 1) {
    console.error(`${run} matches ${stamps.length} runs (${stamps.join(', ')}): give more of the stamp`)
    process.exit(2)
  }
  const stamp = stamps[0] ?? run

  const arms: ArmSummary[] = []
  const listings: string[] = []
  for (const arm of armList.split(',').filter(Boolean)) {
    const sessions: SessionResult[] = []
    for (const rep of repsOf(stamp, arm)) {
      const session = loadSession(stamp, arm, rep)
      if (!session) continue
      const result = analyzeSession(session)
      sessions.push(result)
      if (listing) listings.push(renderListing(`${run} ${arm} r${rep}`, result.infos))
    }
    if (!sessions.length) console.error(`${arm}: no transcripts for run ${stamp}`)
    arms.push(summarizeArm(arm, sessions))
  }
  if (arms.every(a => !a.rows.length)) process.exit(1)
  console.log(renderReport(run, arms))
  if (listing) console.log(listings.join('\n'))
}

main()
