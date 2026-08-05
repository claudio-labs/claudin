/**
 * Success-path budget.
 *
 * Summary-first rendering for the command shapes that carry the payload —
 * measured over 760 recorded sessions, `git diff` (428k chars), `git status`
 * (234k) and `gh run` (202k) lead. Everything else falls through unchanged.
 *
 * The no-win guard is the rule that keeps a lossy mode honest: ship the summary
 * only when it is <=70% of what it replaces, otherwise return the input. It is
 * enforced HERE, once, rather than in each renderer, so a renderer cannot
 * forget it.
 *
 * Deliberately absent: `git log`. The Bash output filter already rewrites it to
 * `--oneline`, and replaying the corpus showed nothing left to take — a
 * summarizer that fires for no gain is worse than none, because it is one more
 * thing that can be wrong.
 *
 * `scripts/profile/git-summarizer-replay.ts` replays the recorded corpus
 * through this module; every threshold below was chosen from that run.
 */
import { logError } from '../../utils/log.js'
import { renderDiff } from './parsers/diff.js'
import { renderIssueView, renderRunLog } from './parsers/gh.js'
import { renderStatusShort } from './parsers/status.js'

/** Ship a summary only when it saves at least this much. */
export const NO_WIN_RATIO = 0.7

const WHITESPACE_RE = /\s+/

/**
 * Global options that sit BEFORE the subcommand and take a value, so the
 * subcommand is two tokens further along. `git -C <dir> diff` is 46 calls in
 * the corpus — treating `-C` as the subcommand would silently skip every one.
 */
const GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree'])
const GLOBAL_FLAG_RE = /^--(?:no-pager|paginate|bare|literal-pathspecs|no-replace-objects)$/

type Renderer = (text: string) => string | null

/** The first token that is not a global option. */
function subcommandOf(tokens: readonly string[]): string | undefined {
  let i = 1
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (GLOBAL_OPTS_WITH_VALUE.has(token)) {
      i += 2
      continue
    }
    if (token.includes('=') && token.startsWith('--')) {
      i += 1
      continue
    }
    if (GLOBAL_FLAG_RE.test(token)) {
      i += 1
      continue
    }
    return token
  }
  return undefined
}

/**
 * Pick a renderer from the command.
 *
 * For `gh` the FAMILY alone decides nothing and picking on it is a real bug,
 * not a missed win: `gh run view` is a log dump and `gh run list` a table;
 * `gh pr view` is a header-plus-body and `gh pr diff` a unified diff. Keying on
 * `pr` alone sent a 25k-char `gh pr diff` and a long `gh pr list` through
 * `renderIssueView`, which cut both mid-line at the body budget and told the
 * model to fetch "the description" with `--json body`. So the `gh` side keys on
 * the family AND the action, and anything else falls through unchanged.
 *
 * Those two tokens are read positionally, exactly like the grammar's
 * `classifyGh`. The tokenizers have to agree: a command classified read-only
 * there must not pick a renderer here that its output does not fit.
 */
function rendererFor(command: string): Renderer | null {
  const tokens = command.trim().split(WHITESPACE_RE)
  const binary = tokens[0]

  if (binary === 'git') {
    const sub = subcommandOf(tokens)
    // `show` is a commit message plus a diff; renderDiff declines the message.
    if (sub === 'diff' || sub === 'show') return renderDiff
    if (sub === 'status') return renderStatusShort
    return null
  }
  if (binary === 'gh') {
    const family = tokens[1]
    const action = tokens[2]
    // `run view` is pinned for symmetry, not for a bug: `renderRunLog` already
    // declines anything without a timestamp, so `gh run list` was safe.
    if (family === 'run' && action === 'view') return renderRunLog
    if (family === 'pr' && action === 'diff') return renderDiff
    if ((family === 'pr' || family === 'issue') && action === 'view') {
      return renderIssueView
    }
    return null
  }
  return null
}

/**
 * @returns a budgeted rendering of a SUCCESSFUL command's output, or the output
 * unchanged when this command shape has no summarizer or the summary would not
 * pay for itself.
 */
export function summarizeGitOutput(command: string, output: string): string {
  if (!output) return output
  const render = rendererFor(command)
  if (!render) return output

  let summary: string | null
  try {
    summary = render(output)
  } catch (e) {
    // Fallback pattern: a parser that throws must never cost the model its
    // output.
    logError(`Git: budget renderer failed for \`${command}\` — ${String(e)}`)
    return output
  }

  if (summary === null) return output
  return summary.length <= output.length * NO_WIN_RATIO ? summary : output
}
