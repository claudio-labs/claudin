/**
 * Non-TTY `gh` watch output.
 *
 * `gh` only redraws when stdout is a TTY — `IO.RefreshScreen()` and the
 * alternate screen buffer are no-ops otherwise — so under this tool every
 * refresh APPENDS a full block instead of replacing the previous one. A ten
 * minute watch at the default interval leaves ~60 stacked copies, of which only
 * the last is an answer.
 *
 * Provenance, because a parser written against invented bytes is worthless:
 *
 *  - `PR_CHECKS_POLL` is captured verbatim from this repo's PR #72
 *    (`gh pr checks 72 | cat -A`, 2026-08-10): four checks, tab-separated, a
 *    TRAILING tab on every line, and no header row. That is the whole non-TTY
 *    format — the pretty table is TTY-only.
 *  - The `pending` variants and the repetition are synthesized. They are what
 *    the same command prints one interval earlier.
 *  - `RUN_WATCH_POLL` is synthesized from the captured `gh run view` output of
 *    run 31442753617. No run was in flight when the fixture was taken, so the
 *    live in-progress rendering was NOT captured: treat it as a shape fixture.
 *    The collapser anchors on the first non-empty line of a block precisely so
 *    that the interior details it is least sure about cannot matter.
 */

const CHECKS = [
  ['Analyze (actions)', 'https://github.com/claudio-labs/claudin/actions/runs/31442127545/job/93628845967'],
  [
    'Analyze (javascript-typescript)',
    'https://github.com/claudio-labs/claudin/actions/runs/31442127545/job/93628845989',
  ],
  ['CodeQL', 'https://github.com/claudio-labs/claudin/runs/93628962328'],
  ['smoke-and-tests', 'https://github.com/claudio-labs/claudin/actions/runs/31442130244/job/93628851213'],
] as const

/**
 * One `gh pr checks` refresh. `states` and `elapsed` are per check, in the
 * order above; gh prints `0` as the elapsed of a check that has not started.
 */
export function prChecksPoll(
  states: readonly string[],
  elapsed: readonly string[],
): string {
  return CHECKS.map(
    ([name, url], i) => `${name}\t${states[i] ?? 'pass'}\t${elapsed[i] ?? '0'}\t${url}\t`,
  ).join('\n')
}

/** The captured block: every check passing, with its real elapsed column. */
export const PR_CHECKS_POLL = prChecksPoll(
  ['pass', 'pass', 'pass', 'pass'],
  ['42s', '1m54s', '3s', '2m54s'],
)

/** Three refreshes of the same PR, ending green — what `--watch` leaves behind. */
export const PR_CHECKS_WATCH = [
  prChecksPoll(['pending', 'pending', 'pending', 'pending'], ['0', '0', '0', '0']),
  prChecksPoll(['pass', 'pending', 'pass', 'pending'], ['42s', '1m2s', '3s', '1m30s']),
  PR_CHECKS_POLL,
].join('\n')

/** One `gh run watch` refresh. */
export function runWatchPoll(glyph: string, age: string, jobLine: string): string {
  return [
    '',
    `${glyph} main PR Checks · 31442753617`,
    `Triggered via push ${age}`,
    '',
    'JOBS',
    jobLine,
    '',
  ].join('\n')
}

export const RUN_WATCH_POLL = runWatchPoll(
  '✓',
  'about 1 hour ago',
  '✓ smoke-and-tests in 2m53s (ID 93630689192)',
)

/** Three refreshes, ending with the completion line gh prints once. */
export const RUN_WATCH = [
  runWatchPoll('*', 'about 1 minute ago', '* smoke-and-tests in 1m4s (ID 93630689192)'),
  runWatchPoll('*', 'about 2 minutes ago', '* smoke-and-tests in 2m8s (ID 93630689192)'),
  RUN_WATCH_POLL,
  '✓ Run PR Checks (31442753617) completed with success',
].join('\n')
