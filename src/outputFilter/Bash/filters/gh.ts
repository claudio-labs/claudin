// GitHub CLI list filters: rewrite `gh pr/issue/run list` to --json form.
//
// Table output from gh commands is wide and token-heavy; JSON is compact
// and machine-readable. We hard-wire the canonical --json fields and forward
// any user-supplied filter flags (--repo, --author, --state, etc.) so that
// filtering intent is preserved while the output schema stays predictable.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { RewriteContext } from 'src/outputFilter/types.js'
import type { FilterSpec } from 'src/outputFilter/Bash/types.js'

// Prefix-replace on ctx.command (not args.join) so quoted flag values keep
// their internal whitespace verbatim — the rewritten command is executed.
function forwardFlags(
  ctx: RewriteContext,
  match: RegExp,
  base: string,
  fields: string,
): string {
  return ctx.command.replace(match, `${base} --json ${fields}`)
}

// --- gh pr list ------------------------------------------------------------

const GH_PR_LIST_MATCH = /^gh\s+pr\s+list\b/
// Passthrough when the user already requested JSON — output is already compact.
const GH_PR_LIST_REJECT = /--json\b|--format\b|--template\b|--web\b/

const GH_PR_LIST_FIELDS = 'number,title,state,author,headRefName,url'

export const ghPrList: FilterSpec = {
  name: 'gh-pr-list',
  matchCommand: GH_PR_LIST_MATCH,
  matchCommandReject: GH_PR_LIST_REJECT,
  rewriteCommand: (ctx) =>
    forwardFlags(ctx, GH_PR_LIST_MATCH, 'gh pr list', GH_PR_LIST_FIELDS),
}

// --- gh issue list ---------------------------------------------------------

const GH_ISSUE_LIST_MATCH = /^gh\s+issue\s+list\b/
const GH_ISSUE_LIST_REJECT = /--json\b|--format\b|--template\b|--web\b/

const GH_ISSUE_LIST_FIELDS = 'number,title,state,author,url'

export const ghIssueList: FilterSpec = {
  name: 'gh-issue-list',
  matchCommand: GH_ISSUE_LIST_MATCH,
  matchCommandReject: GH_ISSUE_LIST_REJECT,
  rewriteCommand: (ctx) =>
    forwardFlags(ctx, GH_ISSUE_LIST_MATCH, 'gh issue list', GH_ISSUE_LIST_FIELDS),
}

// --- gh run list -----------------------------------------------------------

const GH_RUN_LIST_MATCH = /^gh\s+run\s+list\b/
const GH_RUN_LIST_REJECT = /--json\b|--format\b|--template\b|--web\b/

const GH_RUN_LIST_FIELDS = 'status,conclusion,name,databaseId,headBranch'

export const ghRunList: FilterSpec = {
  name: 'gh-run-list',
  matchCommand: GH_RUN_LIST_MATCH,
  matchCommandReject: GH_RUN_LIST_REJECT,
  rewriteCommand: (ctx) =>
    forwardFlags(ctx, GH_RUN_LIST_MATCH, 'gh run list', GH_RUN_LIST_FIELDS),
}
