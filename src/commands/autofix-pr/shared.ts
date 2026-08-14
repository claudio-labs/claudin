import { z } from 'zod/v4'
import { ClaudeError } from 'src/utils/errors.js'
import { execFileNoThrow } from 'src/utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit } from 'src/utils/git.js'
import { logError } from 'src/utils/log.js'
import { jsonParse } from 'src/utils/slowOperations.js'

export class AutofixPreconditionError extends ClaudeError {
  override name = 'Autofix PR failed'
}

const PrViewSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: z.string().min(1),
})

export type AutofixPreconditions = {
  prNumber: number
  prUrl: string
  branch: string
  defaultBranch: string
}

const GH_AUTH_TIMEOUT_MS = 5000
const GH_PR_VIEW_TIMEOUT_MS = 5000

type PrLookup =
  | { kind: 'open'; number: number; url: string }
  | { kind: 'merged' }
  | { kind: 'closed' }
  | { kind: 'none' }
  | { kind: 'gh_error' }

/**
 * Fetch the PR for the current branch and classify its state precisely.
 * Distinguishes "no PR" (create one) from "merged/closed" (different action)
 * from "gh failure" (retry / check connectivity).
 */
async function fetchPrForAutofix(): Promise<PrLookup> {
  const result = await execFileNoThrow(
    'gh',
    ['pr', 'view', '--json', 'number,url,state'],
    { timeout: GH_PR_VIEW_TIMEOUT_MS, preserveOutputOnError: true },
  )

  if (result.code !== 0) {
    const stderr = (result.stderr ?? '').toLowerCase()
    if (stderr.includes('no pull requests found')) return { kind: 'none' }
    return { kind: 'gh_error' }
  }

  const stdout = result.stdout.trim()
  if (!stdout) return { kind: 'gh_error' }

  let parsed: unknown
  try {
    parsed = jsonParse(stdout)
  } catch (e) {
    logError(
      new Error('autofix-pr: failed to parse `gh pr view` JSON', { cause: e }),
    )
    return { kind: 'gh_error' }
  }

  const validation = PrViewSchema.safeParse(parsed)
  if (!validation.success) {
    logError(
      new Error('autofix-pr: `gh pr view` JSON did not match expected schema', {
        cause: validation.error,
      }),
    )
    return { kind: 'gh_error' }
  }

  const data = validation.data
  if (data.state === 'MERGED') return { kind: 'merged' }
  if (data.state === 'CLOSED') return { kind: 'closed' }
  return { kind: 'open', number: data.number, url: data.url }
}

/**
 * Validate that `/autofix-pr` can run in the current environment.
 *
 * Order matters: cheapest, most-actionable failures first. All errors throw
 * AutofixPreconditionError with a one-line message ready for the UI banner
 * ("Autofix PR failed: <msg>").
 */
export async function assertAutofixPreconditions(): Promise<AutofixPreconditions> {
  if (!(await getIsGit())) {
    throw new AutofixPreconditionError('not inside a git repository.')
  }

  const [branch, defaultBranch] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
  ])

  if (branch === 'HEAD') {
    throw new AutofixPreconditionError(
      'cannot run in detached HEAD state. Check out a feature branch first.',
    )
  }

  if (branch === defaultBranch) {
    throw new AutofixPreconditionError(
      `cannot run on the default branch (${defaultBranch}). Check out a feature branch first.`,
    )
  }

  const auth = await execFileNoThrow(
    'gh',
    ['auth', 'status'],
    { timeout: GH_AUTH_TIMEOUT_MS, preserveOutputOnError: false },
  )
  if (auth.code !== 0) {
    throw new AutofixPreconditionError(
      'gh CLI is not authenticated. Run `gh auth login` first.',
    )
  }

  const pr = await fetchPrForAutofix()
  switch (pr.kind) {
    case 'open':
      return { prNumber: pr.number, prUrl: pr.url, branch, defaultBranch }
    case 'none':
      throw new AutofixPreconditionError(
        'no open PR found for this branch. Create one first via /commit-push-pr.',
      )
    case 'merged':
      throw new AutofixPreconditionError(
        'PR for this branch is already merged. Check out a new feature branch.',
      )
    case 'closed':
      throw new AutofixPreconditionError(
        'PR for this branch is closed. Reopen it on GitHub or open a new PR.',
      )
    case 'gh_error':
      throw new AutofixPreconditionError(
        'failed to query PR status via `gh pr view`. Check connectivity and try again.',
      )
  }
}

/**
 * Format instructions reused by both modes when listing PR comments.
 * Kept identical to the prior /pr-comments output so dry-run preserves parity.
 */
export const PR_COMMENTS_FORMAT_INSTRUCTIONS = `Format the comments as:

## Comments

[For each comment thread:]
- @author file.ts#line:
  \`\`\`diff
  [diff_hunk from the API response]
  \`\`\`
  > quoted comment text

  [any replies indented]

If there are no comments, return "No comments found."`

export const FETCH_REFERENCED_CODE_HINT = `If a comment references some code that is not in the diff_hunk, fetch the surrounding context with \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\`.`

/**
 * Triage labels assigned to every collected comment before any action.
 * Drives the default-mode prompt: only `ok` and `change_request` are auto-fixed;
 * `pr_questionable` and `unclear` force a user question; `out_of_scope` is
 * acknowledged in a reply but not acted on.
 */
export const TRIAGE_INSTRUCTIONS = `After collecting comments, assign each one exactly one triage label:

- **ok** — actionable request you can address (typo, bug fix, refactor, missing test, etc.). Fix it.
- **change_request** — comes from a review with state \`CHANGES_REQUESTED\`. Treat as \`ok\` for fixing, but flag it so the final summary mentions that the reviewer must re-approve manually.
- **nit** — low-priority style/preference (the reviewer themselves prefixed with "nit:" or marked it optional). Surface to the user via AskUserQuestion before touching it; default to skipping.
- **praise** — positive feedback with no request ("LGTM", "nice"). Skip silently, no reply.
- **incorrect** — the reviewer's premise is wrong (asks for behaviour the code already has, misreads the diff). Do not fix; post a reply explaining the misunderstanding, no commit.
- **pr_questionable** — reviewer is challenging the design, scope, or intent of the PR itself (e.g. "are we sure we want this?"). Do not fix silently; surface to the user.
- **unclear** — you cannot determine what the reviewer wants without more info (ambiguous wording, missing context, contradictory replies in the thread). Surface to the user.
- **out_of_scope** — references code that is not part of this PR's diff. Acknowledge in a reply, do not fix.

When listing comments, show the label next to the author/file header, e.g. \`- @alice file.ts#42 [ok]:\`.`
