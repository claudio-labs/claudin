import {
  createOneShotMemo,
  createOutputTrimTailStripper,
  MEMO_LIMIT,
} from 'src/tools/shared/redirect.js'
import { acceptsGitCommand } from 'src/tools/GitTool/grammar.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'

export { MEMO_LIMIT }

/**
 * Bash → Git redirect.
 *
 * The model reaches for `git diff` in Bash out of habit — and until this PR the
 * BashTool git instructions explicitly told it to. An appended
 * <system-reminder> is NOT the lever (measured at zero adoption in this
 * codebase); what moves behaviour is a refusal that names the alternative. So
 * BashTool's validateInput declines a bare git/gh READ and points here.
 *
 * Disable with `CLAUDIN_DISABLE_GIT_REDIRECT=1` (read at the BashTool call
 * site, alongside the sibling RunTests, Typecheck and Read/Grep/Glob
 * redirects). `CLAUDIN_DISABLE_GIT_TOOL=1` removes the tool entirely, which
 * also disarms this redirect via the toolset check.
 *
 * Narrow in the usual three ways, plus one of its own:
 *
 *  - Single command only. `git add -A && git commit` is two operations and one
 *    list element cannot express it, so composition stays in Bash. (The Git
 *    tool's answer to a burst is the `commands` LIST, not `&&`.) "One command"
 *    is decided by `acceptsGitCommand` — bash's own quoting rules — and NOT by
 *    the sibling redirects' `hasShellComposition`, which counts any quote as
 *    composition. That regex cost this lane 37 of the recorded reads (2.1% of
 *    every git/gh Bash call, 49k chars): `git log --format='%h %s%n%b'` and
 *    `gh run view … --jq '…'` have a `|` or a `;` INSIDE quotes, where bash
 *    passes it to git verbatim and the tool runs it unchanged. Asking the
 *    grammar also makes the deadlock invariant hold by construction — Bash
 *    cannot refuse a command the tool would refuse too.
 *  - The subcommand must be what the command STARTS with, so
 *    `grep -rn "git diff" src` is not read as a diff. Global options opt out
 *    too: `git -C /elsewhere diff` and `git --no-pager log` do not match, which
 *    is deliberate — they are rarer and a missed redirect costs nothing.
 *  - **Reads only.** `git commit`/`git push` run fine through the tool, but
 *    refusing them in Bash would put a permission dialog between the model and
 *    a mutation it already had permission for, with no token payoff: measured
 *    over 760 sessions the mutating shapes carry 342k chars against 1.36M for
 *    the reads.
 *
 * ONE-SHOT per command: re-sending the identical command runs it. Without that
 * escape there would be no way to get a raw diff at all.
 */

/**
 * The output-trimming tail the model habitually appends to a verbose git
 * command: `| head -50`, `2>&1 | tail -40`, `| grep '^+++'`.
 *
 * This matters more here than in any sibling redirect. Measured over 760
 * recorded sessions (`scripts/bench/perf/git-tool-baseline.ts`): 64 of 162
 * `git diff` calls, 67 of 137 `git log` and 68 of 268 `git status` carry such a
 * tail. Counting them as shell composition would skip roughly a third of the
 * addressable surface — the same mistake that kept the RunTests redirect from
 * ever firing on Rust.
 *
 * The default filter set is used, WITHOUT `wc`: `git diff | wc -l` asks for a
 * line count, and a summarized diff is not that answer.
 */
export const stripOutputTrimTail = createOutputTrimTailStripper()

/**
 * The read-only shapes the Git tool handles. An allowlist, not a heuristic —
 * the cost of a wrong refusal is much higher than the cost of a missed
 * redirect.
 *
 * Anchored at the start with no room for global options, so every match is
 * `git <sub>` or `gh <family> <sub>` exactly.
 *
 * The `gh` side is NARROWER than the grammar's read-only set (24 command pairs
 * plus the `search`/`status` families). What earns a place here is a shape the
 * tool returns something BETTER than the raw dump for, because a refusal costs
 * a round-trip and batching alone did not survive the A/B:
 *
 *  - `gh run view` — the CI-log renderer (`parsers/gh.ts`), and the reason this
 *    line exists. `gh run` is 202k chars of the recorded corpus, third behind
 *    `git diff` and `git status`, and the model reaches for it with a
 *    `| tail -60` glued on precisely because the raw log is unreadable.
 *  - `gh run watch` — the tool gives it a 10-minute ceiling instead of Bash's
 *    2 minutes, a live clock, and a result collapsed to the final refresh
 *    instead of every refresh stacked. (A watch with an explicit `-i` interval
 *    does NOT redirect: `-i` is in the opt-out set below because it means
 *    `--interactive` everywhere else. A missed redirect costs nothing.)
 *  - `gh pr diff` — a unified diff, so it gets the diff budget AND the delta
 *    lane on a re-read, exactly like `git diff`.
 *  - `gh pr view` / `gh issue view` — the body budget.
 *
 * Left in Bash on purpose: the table reads (`gh run list`, `gh issue list`,
 * `gh workflow view`, `gh release view`) and `gh api`. The tool hands all of
 * them back unchanged — `renderRunLog` declines a table by design — so
 * refusing them would spend a round-trip for nothing. `gh pr list`/`gh pr
 * checks` predate this rule and stay for continuity.
 */
const REDIRECTABLE_RE =
  /^(?:git\s+(?:diff|log|status|show|blame)|gh\s+(?:pr\s+(?:view|list|checks|diff)|issue\s+view|run\s+(?:view|watch)))\b/

/**
 * Flags that mean the model wants something this tool is not.
 *
 * `-i`/`--interactive` needs a TTY (the tool refuses those forms outright, so
 * redirecting one would leave the command with nowhere to run — the deadlock
 * gotcha), `--web` opens a browser, and `--help`/`-h` is documentation rather
 * than a read of the repository.
 *
 * Note `-p`/`--patch` is deliberately absent: for `log`/`show`/`diff` — the
 * only commands this allowlist admits — it means "show the patch", not
 * "interactive".
 */
const OPT_OUT_FLAG_RE = /\s(?:-i|--interactive|--web|--help|-h)(?:[\s=]|$)/

/** Pure predicate: would the Git tool run this command just as well? */
export function isRedirectableGitCommand(command: string): boolean {
  const cmd = stripOutputTrimTail(command.trim())
  if (!cmd) return false
  if (OPT_OUT_FLAG_RE.test(cmd)) return false
  if (!REDIRECTABLE_RE.test(cmd)) return false
  // Last, and only for the handful of shapes above: this tokenizes the command.
  return acceptsGitCommand(cmd)
}

/**
 * This tool's own refusal memo — see the shared module for why it is not
 * shared with the sibling redirects.
 */
const memo = createOneShotMemo(MEMO_LIMIT)

/**
 * Stateful gate. Records the command as refused, so the SECOND identical call
 * runs — the escape hatch the message promises.
 */
export function shouldRedirectToGit(command: string): boolean {
  if (!isRedirectableGitCommand(command)) return false
  return memo.shouldRefuse(command)
}

export function resetGitRedirectMemoForTesting(): void {
  memo.reset()
}

export function renderGitRedirect(command: string): string {
  const cmd = command.trim()
  const core = stripOutputTrimTail(cmd)
  return [
    `Blocked: \`${cmd}\` reads the repository, and ${GIT_TOOL_NAME} is available.`,
    `Call ${GIT_TOOL_NAME} instead — it runs the same command and returns a budgeted result instead of the raw dump.`,
    `Pass commands: [${JSON.stringify(core)}].`,
    `${GIT_TOOL_NAME} takes a LIST, so send the whole burst in one call rather than one call each — e.g. commands: ["git status", "git diff", "git log -5"].`,
    ...(core === cmd
      ? []
      : [
          `The output filter is dropped on purpose — ${GIT_TOOL_NAME} already caps what it returns, and its result carries stderr without \`2>&1\`.`,
        ]),
    `If you specifically need raw git output, re-send this exact Bash command and it will run.`,
  ].join(' ')
}
